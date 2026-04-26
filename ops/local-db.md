# Local Postgres workflow

Dev setup runs Postgres 17 in a Docker container — same major version
as Neon (Neon defaults new projects to 17). The same version pins
through to the VPS later, so when you migrate prod off Neon it'll be a
straight `pg_dump` → `pg_restore` with no cross-version drama.

All commands below assume you're in the `lol-tricks-api/` directory.

## Prerequisites

- Docker Desktop / Docker Engine with Compose v2 (`docker compose version`
  should print ≥ 2.0). If you see the legacy `docker-compose` (hyphen)
  binary only, upgrade — the syntax below uses the v2 subcommand.
- Free disk: **≥ 20 GB**. A full Master+ backfill (~3 regions × top-2000
  Master + full Chall/GM + 60 days of matches) lands around 10–15 GB raw
  + indexes. The Docker volume lives at `ops/pgdata/` and is gitignored.
- `pg_dump` / `pg_restore` on PATH if you want to rescue the existing
  Neon data. On macOS: `brew install libpq && brew link --force libpq`.
  On Ubuntu: `sudo apt install postgresql-client-17`. Must be the
  **client 17 or newer** — an older client can't read a server 16 dump.

## Start the database

```bash
docker compose -f ops/docker-compose.yml up -d
```

The container exposes `localhost:5432` with user `loltricks` /
password `loltricks` / db `loltricks`. The default `DATABASE_URL` in
`.env.example` already points at it, so copying `.env.example` →
`.env` and adding your Riot key is enough to be up and running.

Check it's alive:

```bash
docker compose -f ops/docker-compose.yml ps
docker compose -f ops/docker-compose.yml logs --tail=20 postgres
```

## Apply the schema

Once the container is up, create the tables:

```bash
npx prisma migrate deploy
```

`migrate deploy` (not `migrate dev`) runs every migration in
`prisma/migrations/` exactly once, never opens a shadow database, and
never prompts. It's the right command for a fresh empty DB and for
production — symmetric with what you'll run on the VPS later.

Verify:

```bash
npx prisma db pull --print | head -30   # should list Player, Match, …
```

## Option A — Start clean

Skip the Neon dump and let `ops/seed-masters.cjs` + `ops/deep-backfill.cjs`
repopulate from scratch. This is the cleanest path if Neon is tight on
storage and you'd rather not spend transfer budget on a dump.

```bash
node ops/seed-masters.cjs                      # Player rows (~20 min)
node ops/deep-backfill.cjs --key=1 --region=euw &
node ops/deep-backfill.cjs --key=2 --region=na  &
node ops/deep-backfill.cjs --key=3 --region=kr  &
wait
```

State files `ops/state-{region}.json` let you Ctrl+C and resume any time.

## Option B — Rescue what's already in Neon

If you don't want to throw away the data you've already ingested:

```bash
# 1. Dump Neon — custom format (-Fc) compresses + allows parallel restore.
pg_dump "$NEON_DATABASE_URL" \
  --no-owner --no-privileges \
  -Fc -f neon.dump

# 2. Restore into the local container.
pg_restore \
  --no-owner --no-privileges \
  -d "postgresql://loltricks:loltricks@localhost:5432/loltricks" \
  -j 4 \
  neon.dump
```

`-j 4` restores four tables in parallel — worth it for the big
`MatchParticipant` table. Drop it to `-j 1` if the host machine
struggles.

Afterwards, repoint `.env` at the local DB and resume backfill — the
state files already know which puuids are done.

> Neon free tier throttles bulk reads. If the dump stalls or drops,
> `pg_dump` with `--no-sync` + retrying specific tables via
> `-t "\"MatchParticipant\""` is the usual workaround. Or just fall
> back to Option A.

## Resetting the database

Sometimes you want a clean slate (schema changed, data got weird,
testing a migration):

```bash
docker compose -f ops/docker-compose.yml down -v   # -v wipes the volume
docker compose -f ops/docker-compose.yml up -d
npx prisma migrate deploy
```

Every trace is gone — the state files in `ops/` are the only thing
left, and you'll probably want to delete them too if you're doing a
full reset:

```bash
rm ops/state-*.json ops/logs/deep-backfill.*.state.json
```

## Stopping (without wiping)

```bash
docker compose -f ops/docker-compose.yml stop
```

`stop` leaves the volume intact. `down` without `-v` removes the
container but keeps the data. Only `down -v` nukes it.

## Checking the DB size

```bash
docker compose -f ops/docker-compose.yml exec postgres \
  psql -U loltricks -d loltricks -c "
    SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
    FROM pg_class
    WHERE relkind = 'r'
    ORDER BY pg_total_relation_size(oid) DESC
    LIMIT 10;
  "
```

Expect `MatchParticipant` to dwarf everything else.

## Migrating to a VPS later

When it's time to go live:

```bash
# 1. Dump local.
pg_dump "postgresql://loltricks:loltricks@localhost:5432/loltricks" \
  --no-owner --no-privileges -Fc -f backup.dump

# 2. On the VPS: install Postgres 17 (same major version as here),
#    create a role + db, set pg_hba to accept the Vercel IP range or
#    front it with Tailscale/WireGuard. Optionally add PgBouncer in
#    transaction mode — Vercel's serverless lambdas will exhaust raw
#    Postgres connections otherwise.

# 3. Copy backup.dump to the VPS, then:
pg_restore --no-owner --no-privileges -d "$VPS_DB_URL" -j 4 backup.dump

# 4. Update DATABASE_URL in Vercel env vars and redeploy.
```

Important: **match the Postgres major version** between local and VPS.
`pg_restore` is forward-compatible (16 → 17 works) but not backward
(17 dump → 16 server fails — `transaction_timeout` and friends are
PG17-only). Sticking with 17 on both sides is the simplest rule.
