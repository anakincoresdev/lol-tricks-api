#!/usr/bin/env bash
# Long-running backfill loop. Start once with:
#
#   cd lol-tricks-api && nohup ./ops/run-forever.sh > ops/logs/nohup.out 2>&1 &
#
# and walk away. It will:
#   - refresh the Master+ tier list each cycle (seed-masters)
#   - reset backfill cursors so new matches get pulled
#   - run deep-backfill until the rate budget is exhausted for the cycle
#   - dump ops/logs/status.json every ~15 min (for the Cowork dashboard)
#   - write a heartbeat to ops/logs/heartbeat.txt once a minute
#
# Safe to kill (Ctrl+C / `kill <pid>`) and restart — deep-backfill is
# resumable via ops/logs/deep-backfill.state.json.

set -u
cd "$(dirname "$0")/.."

mkdir -p ops/logs
PIDFILE=ops/logs/run-forever.pid
LOG=ops/logs/run-forever.log

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"; kill $(jobs -p) 2>/dev/null; exit' EXIT INT TERM

log() {
  echo "$(date -Iseconds) $*" | tee -a "$LOG"
}

dump_status() {
  # Atomic write: write to .tmp, then move. So a concurrent reader never
  # sees a half-finished file.
  if node ops/status.cjs --json > ops/logs/status.json.tmp 2>>"$LOG"; then
    mv ops/logs/status.json.tmp ops/logs/status.json
    log "status.json updated"
  else
    log "status.cjs failed — keeping previous status.json"
  fi
}

# Heartbeat (background)
(
  while true; do
    date -Iseconds > ops/logs/heartbeat.txt
    sleep 60
  done
) &

# Periodic status dump (background)
(
  while true; do
    sleep 900    # 15 min
    dump_status
  done
) &

log "run-forever starting (pid=$$)"

CYCLE=0
while true; do
  CYCLE=$((CYCLE + 1))
  log "===== cycle #$CYCLE — seed-masters ====="
  node ops/seed-masters.cjs 2>&1 | tee -a "$LOG" || log "seed-masters errored — continuing"

  dump_status

  log "===== cycle #$CYCLE — deep-backfill (reset cursors) ====="
  # Reset cursors every cycle so we also pick up matches played since the
  # last pass. Duplicates are deduped via Match.matchId unique constraint.
  node ops/deep-backfill.cjs --reset 2>&1 | tee -a "$LOG" || log "deep-backfill errored — continuing"

  dump_status

  log "===== cycle #$CYCLE done, sleeping 1h ====="
  sleep 3600
done
