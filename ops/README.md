# ops/

Local scripts that populate the DB so `/api/riot/champion-players/global`
has data to return. Designed to run on the developer's machine against the
remote Neon database — **they hit the Riot API directly** and don't go
through the Express server.

Regions covered: **euw**, **na**, **kr**.

## Rate limit

`shared.cjs` enforces `100 requests / 120 seconds` (dev-key default) with
a global token bucket. All three scripts share that bucket, so you can run
them sequentially without worrying about 429s. Burst spacing: 100 ms. On a
real 429 response the client respects `Retry-After` and retries.

To tune:

```bash
RL_MAX_IN_WINDOW=70 node ops/deep-backfill.cjs   # more conservative
```

## Scripts

| Script | Purpose |
|---|---|
| `seed-masters.cjs` | Upsert Challenger/GM/Master Player rows across euw/na/kr. Master tier is capped to top-400 by LP. |
| `deep-backfill.cjs` | For every Master+ puuid, pull ranked-solo match history over the last 60 days (up to 120 matches per player). Resumable via `logs/deep-backfill.state.json`. |
| `status.cjs` | Print DB coverage across all 160+ champions (strict / relaxed / open). |
| `run-all.sh` | Orchestrator: seed → status → backfill → status. |

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
