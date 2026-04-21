import { Router } from 'express'
import { prisma } from '../prisma.js'

const router = Router()

interface GlobalPlayerRow {
  puuid: string
  gameName: string
  region: string
  tier: string
  rank: string
  lp: number
  totalGames: bigint
  championGames: bigint
  championWins: bigint
  roleTop: bigint
  roleJungle: bigint
  roleMid: bigint
  roleAdc: bigint
  roleSupport: bigint
  qualityTier: number
}

// Quality tier meaning:
//   0 = "main"     — strict filters: ≥30 games, ≥20% share, WR>50%
//   1 = "regular"  — relaxed:        ≥10 games, ≥10% share, WR>50%
//   2 = "casual"   — ≥5 games on champion, any share, any WR
//   3 = "trial"    — 2-4 games on champion (fallback so rare picks aren't empty)
//
// Players surface best-tier-first, then by LP DESC. The endpoint fills
// ${limit} slots by taking the best players available — so popular champs
// stay main/regular/casual only (trial never surfaces when enough ≥5-game
// players exist), and rare champs still return meaningful candidates instead
// of an empty list. Champions nobody has played 2+ times in Master+ over 60
// days (e.g. completely off-meta) will still return []: that's a data
// reality, not a bug — the UI should label it as "not enough data".
router.get('/champion-players/global', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const limit = Math.min(Number(req.query['limit']) || 100, 500)

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
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'UTILITY')::bigint AS "roleSupport"
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
      ws."totalGames",
      ws."championGames",
      ws."championWins",
      ws."roleTop",
      ws."roleJungle",
      ws."roleMid",
      ws."roleAdc",
      ws."roleSupport",
      CASE
        WHEN ws."totalGames" >= 30
             AND ws."championGames"::float >= 0.20 * ws."totalGames"::float
             AND ws."championWins"::float / NULLIF(ws."championGames", 0)::float > 0.5
          THEN 0
        WHEN ws."totalGames" >= 10
             AND ws."championGames"::float >= 0.10 * ws."totalGames"::float
             AND ws."championWins"::float / NULLIF(ws."championGames", 0)::float > 0.5
          THEN 1
        WHEN ws."championGames" >= 5
          THEN 2
        ELSE 3
      END AS "qualityTier"
    FROM "Player" p
    INNER JOIN window_stats ws
      ON ws.puuid = p.puuid AND ws.region = p.region
    WHERE p.tier IN ('MASTER', 'GRANDMASTER', 'CHALLENGER')
      AND ws."championGames" >= 2
    ORDER BY "qualityTier" ASC, p.lp DESC
    LIMIT ${limit}
  `

  const QUALITY_LABELS: Record<number, string> = {
    0: 'main',
    1: 'regular',
    2: 'casual',
    3: 'trial',
  }

  const players = rows.map((r) => {
    const total = Number(r.totalGames)
    const champGames = Number(r.championGames)
    const champWins = Number(r.championWins)
    return {
      puuid: r.puuid,
      gameName: r.gameName,
      region: r.region,
      tier: r.tier,
      rank: r.rank,
      lp: r.lp,
      totalGames: total,
      championGames: champGames,
      championWins: champWins,
      championLosses: champGames - champWins,
      championWinRate:
        champGames > 0 ? Math.round((champWins / champGames) * 100) : 0,
      championShare:
        total > 0 ? Math.round((champGames / total) * 100) : 0,
      quality: QUALITY_LABELS[Number(r.qualityTier)] ?? 'trial',
      roles: {
        top: Number(r.roleTop),
        jungle: Number(r.roleJungle),
        mid: Number(r.roleMid),
        adc: Number(r.roleAdc),
        support: Number(r.roleSupport),
      },
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
