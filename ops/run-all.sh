#!/usr/bin/env bash
# Orchestrator. Run once; tail ops/logs/run-all.log to watch progress.
#
# What it does:
#   1. seed-masters — populate Player rows for Challenger/GM/Master on euw/na/kr
#   2. deep-backfill — pull 60 days of ranked solo matches for each Master+ puuid
#   3. status — print coverage across all champions
#
# Safe to re-run: deep-backfill is resumable via ops/logs/deep-backfill.state.json.

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p ops/logs
LOG=ops/logs/run-all.log
echo "$(date -Iseconds) run-all starting" | tee -a "$LOG"

echo "---- seed-masters ----" | tee -a "$LOG"
node ops/seed-masters.cjs 2>&1 | tee -a "$LOG"

echo "---- status (after seed) ----" | tee -a "$LOG"
node ops/status.cjs 2>&1 | tee -a ops/logs/status-after-seed.log | tail -20 | tee -a "$LOG"

echo "---- deep-backfill ----" | tee -a "$LOG"
node ops/deep-backfill.cjs 2>&1 | tee -a "$LOG"

echo "---- status (final) ----" | tee -a "$LOG"
node ops/status.cjs 2>&1 | tee -a ops/logs/status-final.log | tail -40 | tee -a "$LOG"

echo "$(date -Iseconds) run-all done" | tee -a "$LOG"
