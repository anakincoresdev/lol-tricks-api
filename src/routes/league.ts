import { Router } from 'express'
import { getPlatformHost, riotFetch } from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import type { LeagueList } from '../types/riot.js'

const router = Router()

const VALID_TIERS = ['challenger', 'grandmaster', 'master']

/**
 * @swagger
 * /api/riot/league/{tier}:
 *   get:
 *     summary: Get top players by tier
 *     description: Returns top 50 players sorted by LP for a given ranked tier.
 *     tags: [League]
 *     parameters:
 *       - in: path
 *         name: tier
 *         required: true
 *         schema:
 *           type: string
 *           enum: [challenger, grandmaster, master]
 *         description: Ranked tier
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *           default: euw
 *         description: Server region (euw, na, kr, etc.)
 *     responses:
 *       200:
 *         description: List of top players
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tier:
 *                   type: string
 *                 region:
 *                   type: string
 *                 players:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       puuid:
 *                         type: string
 *                       tier:
 *                         type: string
 *                       lp:
 *                         type: integer
 *                       wins:
 *                         type: integer
 *                       losses:
 *                         type: integer
 *                       winRate:
 *                         type: integer
 *                       hotStreak:
 *                         type: boolean
 *       400:
 *         description: Invalid tier
 */
router.get('/league/:tier', async (req, res) => {
  const { tier } = req.params
  const region = (req.query['region'] as string) ?? 'euw'

  if (!tier || !VALID_TIERS.includes(tier)) {
    res.status(400).json({
      error: 'Invalid tier. Must be: challenger, grandmaster, or master.',
    })
    return
  }

  const host = getPlatformHost(region)
  const path = `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`

  const data = await riotFetch<LeagueList>(host, path)

  const sorted = data.entries
    .sort((a, b) => b.leaguePoints - a.leaguePoints)
    .slice(0, 50)
    .map((entry) => ({
      summonerId: entry.summonerId,
      puuid: entry.puuid,
      tier: data.tier,
      rank: entry.rank,
      lp: entry.leaguePoints,
      wins: entry.wins,
      losses: entry.losses,
      winRate: Math.round((entry.wins / (entry.wins + entry.losses)) * 100),
      hotStreak: entry.hotStreak,
    }))

  // Cache players in DB
  for (const player of sorted) {
    await prisma.player.upsert({
      where: { puuid_region: { puuid: player.puuid, region } },
      update: {
        tier: player.tier,
        rank: player.rank,
        lp: player.lp,
        wins: player.wins,
        losses: player.losses,
        winRate: player.winRate,
        hotStreak: player.hotStreak,
      },
      create: {
        puuid: player.puuid,
        gameName: 'Unknown',
        region,
        tier: player.tier,
        rank: player.rank,
        lp: player.lp,
        wins: player.wins,
        losses: player.losses,
        winRate: player.winRate,
        hotStreak: player.hotStreak,
      },
    })
  }

  res.json({ tier: data.tier, region, players: sorted })
})

export default router
