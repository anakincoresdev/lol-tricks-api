# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm run dev           # tsx watch src/index.ts (Express on PORT, default 3001)
npm run build         # tsc → dist/
npm run start         # node dist/index.js (prod)
npm run db:migrate    # prisma migrate dev   (new migration during dev)
npm run db:generate   # prisma generate      (after schema changes)
npm run db:studio     # prisma studio        (GUI browser for the DB)
```

Ops scripts are plain Node CJS — no build step, just `node ops/<script>.cjs`.

## Architecture

Node 20 / TypeScript / Express 5 / Prisma 6 / PostgreSQL. The Express
server is stateless and serves a small set of routes under
`/api/riot/*`. All heavy ingestion lives in `ops/` and runs on the
developer's machine, writing directly to the DB — never through the
Express server.

### Routes (src/routes/)

- **`champion-players-global.ts`** — the main endpoint. Returns every
  qualifying Master+ OTP for a champion across tracked regions with
  runes, KDA, first-item, roles, and a `main`/`regular` quality label.
  Uniform hard filter: rank ∈ {MASTER, GM, CHALLENGER} ∧ championGames > 10
  ∧ ≥15% play rate ∧ WR > 50%. Raw SQL via `prisma.$queryRaw` because
  the aggregates (`MODE() WITHIN GROUP`, `FILTER (WHERE …)`) can't be
  expressed in the Prisma query builder.
- **`champion-players.ts`** — older per-region variant, kept for
  compatibility.
- **`player-champion-matches.ts`** — match history for a single
  `(puuid, championName)`, used by the `/champion/[id]/player/[puuid]`
  page on the frontend.
- **`otp.ts`, `league.ts`, `matches.ts`, `collect.ts`, `sync-tiers.ts`** —
  supporting endpoints and admin utilities. Some call Riot directly
  with `CRON_SECRET` auth.

### Database (prisma/schema.prisma)

- `Player` — one row per (puuid, region). Tier/rank/LP/winRate/profileIconId.
- `Match` / `MatchParticipant` — 60-day match history for tracked puuids.
  `MatchParticipant.items` and `.runes` are `Json` columns. `firstLegendaryId`
  is populated later by `ops/backfill-timeline.cjs`.
- `ChampionMastery`, `PlayerChampion`, `CollectionLog` — auxiliary.

Nothing Neon-specific in the schema — it runs on stock Postgres 17.

### Ops (ops/)

Populates the DB. See [`ops/README.md`](./ops/README.md) for the full
map. The short version:

1. `seed-masters.cjs` — upsert Master+ Player rows (Chall/GM full,
   Master top-2000 by LP by default).
2. `deep-backfill.cjs` — 60-day match history per puuid. Resumable per
   region via state files; supports `--key=1|2|3` so three terminals
   with three keys can run in parallel at ~3× throughput.
3. `backfill-timeline.cjs` — extracts `firstLegendaryId` from Match-v5
   timelines for rows that are missing it.
4. `status.cjs` — coverage report across all champions.

### Rate limit

Every Riot call goes through `riotFetch` in `ops/shared.cjs`, which
enforces 100 requests / 120s (dev-key default) with a token bucket +
Retry-After on 429. Rate-limiting is **per Node process**, so three
parallel backfills (one per region, one key each) each get their own
bucket. Invalid/expired keys surface as a dedicated 401/403 `ApiError`
with a "regenerate at developer.riotgames.com" hint.

## Local development

```bash
# First time:
cp .env.example .env                                      # then edit
docker compose -f ops/docker-compose.yml up -d            # Postgres 17
npx prisma migrate deploy                                 # schema
npm install

# Every run:
npm run dev                                               # Express on 3001
```

`.env` needs `DATABASE_URL` (the default in `.env.example` points at
the docker-compose container) and at least one `RIOT_API_KEY`.

Full local-DB workflow (dumping from Neon, resetting, future VPS
migration) is in [`ops/local-db.md`](./ops/local-db.md).

## Code style

- TypeScript strict mode. `noUncheckedIndexedAccess` — use bracket
  notation for index access (`obj['key']`, `req.query['param']`).
- No semicolons, single quotes, trailing commas, 80-char width.
- Ops scripts are CJS (`.cjs`, `require()`) so they run under plain
  `node` without a build step. API code is ESM TS (`.ts`, `import`),
  compiled to ESM via `tsc`.
- Raw SQL in routes goes through `prisma.$queryRaw` with tagged
  template interpolation — never build SQL from `+` or template
  literals (injection risk + Prisma can't parameterise).

## Deployment

Currently Vercel (`vercel.json`, serverless `api/` entry).
`DATABASE_URL` points at Neon today; the plan is to move to a
self-hosted Postgres on a VPS — see `ops/local-db.md` for the
migration path. Every deploy needs `DATABASE_URL` and `RIOT_API_KEY`
set in Vercel env; `CRON_SECRET` is required for admin endpoints.

## Important caveats

- **Dev Riot keys live 24h**, and every script bails loudly on 401/403
  with a "regenerate and update .env" message. This isn't a bug —
  it's the normal Riot dev-key lifecycle.
- **`deep-backfill.cjs` is idempotent** — Ctrl+C is safe, progress is
  persisted to the per-region state file, and rerun picks up exactly
  where it left off.
- **Regions are fixed at euw / na / kr.** Adding a region means
  touching `ops/shared.cjs` (hosts), `seed-masters.cjs` defaults, and
  the frontend region config — don't expand the set on a whim.
- **Master cap defaults to 2000** in `seed-masters.cjs`. Overriding
  it upward multiplies the backfill runtime. `--master-cap=0` removes
  the cap entirely, which is almost never what you want on a dev key.
