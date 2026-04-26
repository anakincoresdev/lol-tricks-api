# ops/

Local scripts that populate the DB so `/api/riot/champion-players/global`
has data to return. They hit the Riot API directly from the developer's
machine and don't go through the Express server.

Regions covered: **euw**, **na**, **kr**.

## Local database

Dev runs against a Docker-hosted Postgres 16, not Neon:

```bash
docker compose -f ops/docker-compose.yml up -d
npx prisma migrate deploy
```

Full walkthrough (including how to rescue existing Neon data, reset,
and migrate to a VPS later) lives in [`local-db.md`](./local-db.md).

## Rate limit

`shared.cjs` enforces `100 requests / 120 seconds` (dev-key default) with
a global token bucket, per Node process. All scripts in one process share
that bucket. Running three scripts in three terminals — each with a
different Riot key (`--key=1|2|3`) — gives you three independent buckets
and ~3× throughput. Burst spacing: 100 ms. On a real 429 response the
client respects `Retry-After` and retries.

To tune a single process:

```bash
RL_MAX_IN_WINDOW=70 node ops/deep-backfill.cjs   # more conservative
```

## Scripts

| Script | Purpose |
|---|---|
| `seed-masters.cjs` | Upsert Challenger/GM/Master `Player` rows across euw/na/kr. Chall/GM always full (Riot caps them at 300/700 per region). Master capped to top-2000 by LP by default — override with `--master-cap=N` or `--master-cap=0` for no cap. |
| `deep-backfill.cjs` | For every Master+ puuid, pull ranked-solo match history over the last 60 days (up to 500 matches per player by default). Resumable via `ops/logs/deep-backfill.<region>.state.json` (one state file per region when invoked with `--region=…`). |
| `backfill-timeline.cjs` | Walks `MatchParticipant` rows missing `firstLegendaryId`, fetches the Match-v5 timeline, and records the first legendary item purchased that game. Required for the "F" column on the champion page. |
| `status.cjs` | Print DB coverage across all 170+ champions. `--json` for machine-readable output. |
| `run-all.sh` | Orchestrator: seed → status → backfill → status. |
| `run-forever.sh` | Daemon loop (optional, for long unattended runs). |

## Key switching

If you keep up to three Riot keys live at once (in `.env` as
`RIOT_API_KEY`, `RIOT_API_KEY_SECOND`, `RIOT_API_KEY_THIRD`), pass
`--key=1|2|3` to any script to pick which one it uses. This lets you
run one backfill per region in parallel without juggling shell
exports:

```bash
node ops/deep-backfill.cjs --key=1 --region=euw &
node ops/deep-backfill.cjs --key=2 --region=na  &
node ops/deep-backfill.cjs --key=3 --region=kr  &
wait
```

Each per-region run gets its own state file
(`ops/logs/deep-backfill.<region>.state.json`), so the three
processes don't clobber each other's cursors.

## One-command run (one-shot)

```bash
cd lol-tricks-api
./ops/run-all.sh
```

Output streams to stdout and `ops/logs/run-all.log`. Coverage snapshots
land in `ops/logs/status-after-seed.log` and `ops/logs/status-final.log`.

## Fire-and-forget daemon

Start once and walk away — it keeps cycling forever and writes
`ops/logs/status.json` every 15 minutes for the Cowork dashboard:

```bash
cd lol-tricks-api
nohup ./ops/run-forever.sh > ops/logs/nohup.out 2>&1 &
```

To see it's alive: `cat ops/logs/heartbeat.txt` (updated every minute).
To stop: `kill $(cat ops/logs/run-forever.pid)`.

To keep going after a disconnect, just rerun — `deep-backfill.cjs` skips
puuids whose cursor is already marked `done`, and `run-forever.sh` resets
the cursor at the top of each cycle to pick up new matches.

## Checking progress while it runs

Leave the main script alone in one terminal and, in another:

```bash
tail -f ops/logs/run-all.log
node ops/status.cjs
node ops/status.cjs --champion=Quinn
```
