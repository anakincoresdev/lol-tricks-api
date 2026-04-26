import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'

const router = Router()

interface LiveMatchRow {
  matchId: string
  region: string
  gameCreation: Date
  gameDuration: number
  championName: string
  kills: number
  deaths: number
  assists: number
  win: boolean
  puuid: string
  gameName: string
  tier: string
  rank: string
  lp: number
  profileIconId: number | null
  // Per-(puuid, champion) stats over the 60d window, used to verify that
  // this row represents an actual OTP and not a one-off game. All
  // bigints out of COUNT(*).
  totalGames: bigint
  championGames: bigint
  championWins: bigint
}

// Live OTP Feed — the home-page "proof of freshness" block.
//
// Returns the N most recent ranked solo matches (queueId = 420) played
// by a qualifying Master+ OTP on their OTP-champion. One row per
// (match × player): if two tracked OTPs ended up in the same game on
// their respective mains, both rows are returned. The "OTP-ness" of a
// player on the specific champion they played in a given match is the
// same uniform hard filter used by `/champion-players/global`:
//
//   - Player.tier ∈ {MASTER, GRANDMASTER, CHALLENGER}
//   - championGames > 10 in the 60d window
//   - championGames / totalGames ≥ 15%  (play-rate floor)
//   - championWins / championGames > 50% (win-rate floor)
//
// This way the feed only ever surfaces "Yasuo OTP just played Yasuo",
// never "Yasuo OTP dabbled in a Vayne game". The `CROSS JOIN LATERAL`
// fetches window_stats for the specific (puuid, champion) of the row,
// so a player showing up with two different champions in two matches
// is evaluated independently for each.
//
// Default limit = 20 (tunable via ?limit=N, clamped to [1, 100]).
// ORDER BY gameCreation DESC so the freshest game surfaces first.
router.get('/live-otp-feed', async (req, res) => {
  const rawLimit = Number(req.query['limit'])
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), 100)
      : 20

  const rows = await prisma.$queryRaw<LiveMatchRow[]>`
    WITH recent_matches AS (
      -- Pull an oversized candidate window first, then re-rank + LIMIT
      -- after the OTP filter. 500 candidates is ~25x the default
      -- response size, which is plenty of headroom for the filter to
      -- reject non-OTP participants without starving the result.
      SELECT
        m.id AS "matchDbId",
        m."matchId",
        m.region,
        m."gameCreation",
        m."gameDuration",
        mp.puuid,
        mp."championName",
        mp.kills,
        mp.deaths,
        mp.assists,
        mp.win
      FROM "MatchParticipant" mp
      INNER JOIN "Match" m ON m.id = mp."matchId"
      INNER JOIN "Player" p
        ON p.puuid = mp.puuid AND p.region = m.region
      WHERE m."queueId" = 420
        AND m."gameCreation" >= NOW() - INTERVAL '60 days'
        AND p.tier IN ('MASTER', 'GRANDMASTER', 'CHALLENGER')
      ORDER BY m."gameCreation" DESC
      LIMIT 500
    )
    SELECT
      rm."matchId",
      rm.region,
      rm."gameCreation",
      rm."gameDuration",
      rm."championName",
      rm.kills,
      rm.deaths,
      rm.assists,
      rm.win,
      p.puuid,
      p."gameName",
      p.tier,
      p.rank,
      p.lp,
      p."profileIconId",
      ws."totalGames",
      ws."championGames",
      ws."championWins"
    FROM recent_matches rm
    INNER JOIN "Player" p
      ON p.puuid = rm.puuid AND p.region = rm.region
    -- Per-row window stats: totalGames and champion-specific aggregates
    -- for the (puuid, championName) seen in this match. LATERAL makes
    -- the subquery re-evaluate per candidate row. We join on the
    -- 60d/queue=420 window so it matches the definition used by
    -- /champion-players/global.
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*)::bigint AS "totalGames",
        COUNT(*) FILTER (
          WHERE mp2."championName" = rm."championName"
        )::bigint AS "championGames",
        COUNT(*) FILTER (
          WHERE mp2."championName" = rm."championName" AND mp2.win
        )::bigint AS "championWins"
      FROM "MatchParticipant" mp2
      INNER JOIN "Match" m2 ON m2.id = mp2."matchId"
      WHERE mp2.puuid = rm.puuid
        AND m2.region = rm.region
        AND m2."queueId" = 420
        AND m2."gameCreation" >= NOW() - INTERVAL '60 days'
    ) ws
    WHERE ws."championGames" > 10
      AND ws."championGames"::float >= 0.15 * ws."totalGames"::float
      AND ws."championWins"::float / NULLIF(ws."championGames", 0)::float > 0.5
    ORDER BY rm."gameCreation" DESC
    LIMIT ${Prisma.sql`${limit}`}
  `

  const matches = rows.map((r) => {
    const champGames = Number(r.championGames)
    const champWins = Number(r.championWins)
    const total = Number(r.totalGames)

    return {
      matchId: r.matchId,
      region: r.region,
      // Unix ms; client turns it into "5 minutes ago" with Intl.RelativeTimeFormat.
      gameCreation: r.gameCreation.getTime(),
      gameDuration: r.gameDuration,
      championName: r.championName,
      kills: r.kills,
      deaths: r.deaths,
      assists: r.assists,
      win: r.win,
      player: {
        puuid: r.puuid,
        gameName: r.gameName,
        tier: r.tier,
        rank: r.rank,
        lp: r.lp,
        profileIconId: r.profileIconId,
        // Context for hover tooltips + debugging — "this player has X
        // games on this champ, WR Y%, play rate Z%". Rounded to ints.
        championGames: champGames,
        championWinRate:
          champGames > 0 ? Math.round((champWins / champGames) * 100) : 0,
        championShare: total > 0 ? Math.round((champGames / total) * 100) : 0,
      },
    }
  })

  res.json({ window: '60d', limit, matches })
})

export default router
