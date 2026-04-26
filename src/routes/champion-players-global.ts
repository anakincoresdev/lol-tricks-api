import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

const router = Router()

interface GlobalPlayerRow {
  puuid: string
  gameName: string
  region: string
  tier: string
  rank: string
  lp: number
  profileIconId: number | null
  totalGames: bigint
  championGames: bigint
  championWins: bigint
  roleTop: bigint
  roleJungle: bigint
  roleMid: bigint
  roleAdc: bigint
  roleSupport: bigint
  qualityTier: number
  // Most-played keystone (perks[0].runes[0]) and secondary rune tree
  // (perks[1].style) across the player's last 60d of games on this
  // champion. MODE() returns NULL if the champion has no games in the
  // window with valid rune data — API response coerces to null.
  keystoneId: number | null
  secondaryStyleId: number | null
  // Average KDA per game on this champion in the 60d window. AVG
  // returns NULL for zero games; endpoint coerces to null.
  avgKills: number | null
  avgDeaths: number | null
  avgAssists: number | null
  // Most-played first legendary item id across the player's champion
  // games in the 60d window. Sourced from MatchParticipant
  // .firstLegendaryId, populated by ops/backfill-timeline.cjs. NULL
  // when no games have a backfilled value yet — the frontend renders
  // a neutral placeholder in that case.
  firstItemId: number | null
}

// Selection criteria (uniform hard filter, all must hold):
//   - Player rank is MASTER / GRANDMASTER / CHALLENGER
//   - championGames > 10 in the 60d window
//   - championGames / totalGames > 15% (play-rate floor)
//   - championWins / championGames > 50% (win-rate floor)
//
// Rationale: the page is an OTP leaderboard, so every row needs to be
// an actual OTP on this champion — not a Challenger who dabbled twice,
// and not a player who loses on them. With 3 parallel backfill processes
// (one per region, one Riot key each) we can afford to ingest exhaustively
// and let the WHERE clause do the filtering, rather than baking sample
// caps into the collector.
//
// Quality tier is a soft label on top of the hard filter:
//   0 = "main"    — ≥30 games AND ≥20% play rate (hard OTP)
//   1 = "regular" — passes the hard filter but below the "main" bar
//
// Players surface main-first, then by LP DESC. By default the endpoint
// returns every qualifying player — the filter already bounds the set
// to at most a few hundred rows per champion. Pass ?limit=N to cap it
// if a client genuinely wants a short list; N is clamped to [1, 1000]
// as a DoS safety net. Champions nobody plays in Master+ over 60 days
// (completely off-meta) will still return []: that's a data reality,
// not a bug — the UI should label it as "not enough data".
router.get('/champion-players/global', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  // undefined → no LIMIT clause. Number() of undefined/'' is NaN → the
  // guard below leaves `limit` undefined; an explicit finite number is
  // clamped to 1..1000 before it reaches SQL.
  const rawLimit = Number(req.query['limit'])
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 1000)
      : undefined

  if (!champion) {
    res.status(400).json({ error: 'Champion parameter is required.' })
    return
  }

  const rows = await prisma.$queryRaw<GlobalPlayerRow[]>`
    WITH window_stats AS (
      SELECT
        mp.puuid,
        m.region,
        COUNT(*)::bigint AS "totalGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS "championGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.win)::bigint AS "championWins",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'TOP')::bigint AS "roleTop",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'JUNGLE')::bigint AS "roleJungle",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'MIDDLE')::bigint AS "roleMid",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'BOTTOM')::bigint AS "roleAdc",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'UTILITY')::bigint AS "roleSupport",
        -- Most-played keystone (perks[0].runes[0]) on this champion
        -- in the 60d window. MODE() ignores NULLs, so games with
        -- missing/empty rune payloads simply don't contribute.
        MODE() WITHIN GROUP (
          ORDER BY NULLIF(mp.runes -> 0 -> 'runes' ->> 0, '')::int
        ) FILTER (
          WHERE mp."championName" = ${champion}
            AND jsonb_typeof(mp.runes -> 0 -> 'runes' -> 0) = 'number'
        ) AS "keystoneId",
        -- Most-played secondary rune tree (perks[1].style).
        MODE() WITHIN GROUP (
          ORDER BY NULLIF(mp.runes -> 1 ->> 'style', '')::int
        ) FILTER (
          WHERE mp."championName" = ${champion}
            AND jsonb_typeof(mp.runes -> 1 -> 'style') = 'number'
        ) AS "secondaryStyleId",
        AVG(mp.kills) FILTER (WHERE mp."championName" = ${champion}) AS "avgKills",
        AVG(mp.deaths) FILTER (WHERE mp."championName" = ${champion}) AS "avgDeaths",
        AVG(mp.assists) FILTER (WHERE mp."championName" = ${champion}) AS "avgAssists",
        -- Most-played first legendary item id on this champion in the 60d
        -- window. MODE() ignores NULLs, so matches that haven't been
        -- backfilled by ops/backfill-timeline.cjs yet simply don't vote —
        -- and if no match has a value, the MODE is NULL.
        MODE() WITHIN GROUP (ORDER BY mp."firstLegendaryId")
          FILTER (
            WHERE mp."championName" = ${champion}
              AND mp."firstLegendaryId" IS NOT NULL
          ) AS "firstItemId"
      FROM "MatchParticipant" mp
      INNER JOIN "Match" m ON m.id = mp."matchId"
      WHERE m."gameCreation" >= NOW() - INTERVAL '60 days'
        AND m."queueId" = 420
      GROUP BY mp.puuid, m.region
    )
    SELECT
      p.puuid,
      p."gameName",
      p.region,
      p.tier,
      p.rank,
      p.lp,
      p."profileIconId",
      ws."totalGames",
      ws."championGames",
      ws."championWins",
      ws."roleTop",
      ws."roleJungle",
      ws."roleMid",
      ws."roleAdc",
      ws."roleSupport",
      ws."keystoneId",
      ws."secondaryStyleId",
      ws."avgKills",
      ws."avgDeaths",
      ws."avgAssists",
      ws."firstItemId",
      CASE
        WHEN ws."championGames" >= 30
             AND ws."championGames"::float >= 0.20 * ws."totalGames"::float
          THEN 0
        ELSE 1
      END AS "qualityTier"
    FROM "Player" p
    INNER JOIN window_stats ws
      ON ws.puuid = p.puuid AND ws.region = p.region
    WHERE p.tier IN ('MASTER', 'GRANDMASTER', 'CHALLENGER')
      -- Uniform hard filter: >10 games on champion, >15% play rate,
      -- >50% win rate on champion. See comment block above.
      AND ws."championGames" > 10
      AND ws."championGames"::float >= 0.15 * ws."totalGames"::float
      AND ws."championWins"::float / NULLIF(ws."championGames", 0)::float > 0.5
    ORDER BY "qualityTier" ASC, p.lp DESC
    ${limit !== undefined ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `

  const QUALITY_LABELS: Record<number, string> = {
    0: 'main',
    1: 'regular',
  }

  // Round AVGs to one decimal so the wire format is small and the
  // frontend can display "5.3 / 2.1 / 7.4" without extra formatting.
  const round1 = (v: number): number => Math.round(v * 10) / 10

  const players = rows.map((r) => {
    const total = Number(r.totalGames)
    const champGames = Number(r.championGames)
    const champWins = Number(r.championWins)

    const keystone = r.keystoneId == null ? null : Number(r.keystoneId)
    const secondary =
      r.secondaryStyleId == null ? null : Number(r.secondaryStyleId)
    const runes =
      keystone != null && secondary != null
        ? { keystone, secondaryStyle: secondary }
        : null

    const kda =
      r.avgKills != null && r.avgDeaths != null && r.avgAssists != null
        ? {
            kills: round1(Number(r.avgKills)),
            deaths: round1(Number(r.avgDeaths)),
            assists: round1(Number(r.avgAssists)),
          }
        : null

    const firstItem = r.firstItemId == null ? null : Number(r.firstItemId)

    return {
      puuid: r.puuid,
      gameName: r.gameName,
      region: r.region,
      tier: r.tier,
      rank: r.rank,
      lp: r.lp,
      profileIconId: r.profileIconId,
      totalGames: total,
      championGames: champGames,
      championWins: champWins,
      championLosses: champGames - champWins,
      championWinRate:
        champGames > 0 ? Math.round((champWins / champGames) * 100) : 0,
      championShare:
        total > 0 ? Math.round((champGames / total) * 100) : 0,
      quality: QUALITY_LABELS[Number(r.qualityTier)] ?? 'regular',
      roles: {
        top: Number(r.roleTop),
        jungle: Number(r.roleJungle),
        mid: Number(r.roleMid),
        adc: Number(r.roleAdc),
        support: Number(r.roleSupport),
      },
      runes,
      kda,
      firstItem,
    }
  })

  // Debug-friendly counts so callers can see the tier mix at a glance.
  const qualityMix = players.reduce<Record<string, number>>((acc, p) => {
    acc[p.quality] = (acc[p.quality] ?? 0) + 1
    return acc
  }, {})

  res.json({ champion, window: '60d', qualityMix, players })
})

export default router
