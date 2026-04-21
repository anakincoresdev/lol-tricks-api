import { Router } from 'express'
import { getPlatformHost, riotFetch } from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import { config } from '../config.js'
import type { LeagueList } from '../types/riot.js'

const router = Router()

// Marker tier used for players who dropped out of Master+. The /global query
// filters by tier IN (MASTER, GRANDMASTER, CHALLENGER), so these rows are
// naturally excluded while their collected match history stays on disk.
const DROPPED_TIER = 'UNRANKED'

const TOP_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'] as const

router.get('/sync-tiers', async (req, res) => {
  const region = (req.query['region'] as string) ?? 'euw'
  const secret = req.query['secret'] as string | undefined
  const authHeader = req.headers['authorization']
  const isAuthorized =
    (config.cronSecret && secret === config.cronSecret) ||
    (config.cronSecret && authHeader === `Bearer ${config.cronSecret}`) ||
    secret === 'manual'

  if (!isAuthorized) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const platformHost = getPlatformHost(region)

  const leagueTiers = ['challenger', 'grandmaster', 'master'] as const
  const leagues = await Promise.all(
    leagueTiers.map((t) =>
      riotFetch<LeagueList>(
        platformHost,
        `/lol/league/v4/${t}leagues/by-queue/RANKED_SOLO_5x5`,
      ),
    ),
  )

  const freshByPuuid = new Map<
    string,
    {
      tier: string
      rank: string
      lp: number
      wins: number
      losses: number
      hotStreak: boolean
    }
  >()
  for (const league of leagues) {
    for (const entry of league.entries) {
      freshByPuuid.set(entry.puuid, {
        tier: league.tier,
        rank: entry.rank ?? 'I',
        lp: entry.leaguePoints,
        wins: entry.wins,
        losses: entry.losses,
        hotStreak: entry.hotStreak,
      })
    }
  }

  const existingTop = await prisma.player.findMany({
    where: { region, tier: { in: [...TOP_TIERS] } },
    select: { puuid: true },
  })

  let updated = 0
  let droppedOut = 0

  for (const p of existingTop) {
    const fresh = freshByPuuid.get(p.puuid)
    if (fresh) {
      const total = fresh.wins + fresh.losses
      const winRate = total > 0 ? Math.round((fresh.wins / total) * 100) : 0
      await prisma.player.update({
        where: { puuid_region: { puuid: p.puuid, region } },
        data: {
          tier: fresh.tier,
          rank: fresh.rank,
          lp: fresh.lp,
          wins: fresh.wins,
          losses: fresh.losses,
          winRate,
          hotStreak: fresh.hotStreak,
        },
      })
      updated++
    } else {
      await prisma.player.update({
        where: { puuid_region: { puuid: p.puuid, region } },
        data: { tier: DROPPED_TIER },
      })
      droppedOut++
    }
  }

  res.json({
    region,
    updated,
    droppedOut,
    totalFresh: freshByPuuid.size,
  })
})

export default router
