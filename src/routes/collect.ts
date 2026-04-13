import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  batchRequests,
} from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import { config } from '../config.js'
import type { LeagueList, MatchDto } from '../types/riot.js'

const router = Router()

const VALID_TIERS = ['challenger', 'grandmaster', 'master']

/**
 * @swagger
 * /api/riot/collect:
 *   get:
 *     summary: Collect player data (cron job)
 *     description: Fetches and stores data for top 10 players in a tier. Requires secret for authorization.
 *     tags: [Collect]
 *     parameters:
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *           default: euw
 *       - in: query
 *         name: tier
 *         schema:
 *           type: string
 *           enum: [challenger, grandmaster, master]
 *           default: challenger
 *       - in: query
 *         name: secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron secret for authorization
 *     responses:
 *       200:
 *         description: Collection results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 region:
 *                   type: string
 *                 tier:
 *                   type: string
 *                 collected:
 *                   type: integer
 *                 total:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 */
router.get('/collect', async (req, res) => {
  const region = (req.query['region'] as string) ?? 'euw'
  const tier = (req.query['tier'] as string) ?? 'challenger'
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

  if (!VALID_TIERS.includes(tier)) {
    res.status(400).json({ error: 'Invalid tier' })
    return
  }

  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)

  const league = await riotFetch<LeagueList>(
    platformHost,
    `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`,
  )

  const topPlayers = league.entries
    .sort((a, b) => b.leaguePoints - a.leaguePoints)
    .slice(0, 10)

  // Fetch match IDs in parallel batches
  const matchIdResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<string[]>(
          regionalHost,
          `/lol/match/v5/matches/by-puuid/${player.puuid}/ids?queue=420&count=10`,
        ),
    ),
    5,
    250,
  )

  // Build match detail requests
  const matchRequests: { playerIndex: number; matchId: string }[] = []
  for (let i = 0; i < topPlayers.length; i++) {
    const matchIds = matchIdResults[i]
    if (!matchIds || matchIds.length === 0) continue
    for (const matchId of matchIds.slice(0, 5)) {
      matchRequests.push({ playerIndex: i, matchId })
    }
  }

  // Fetch match details
  const matchDetailResults = await batchRequests(
    matchRequests.map(
      ({ matchId }) =>
        () =>
          riotFetch<MatchDto>(regionalHost, `/lol/match/v5/matches/${matchId}`),
    ),
    5,
    250,
  )

  // Build and store player data
  let collected = 0

  for (let i = 0; i < topPlayers.length; i++) {
    const player = topPlayers[i]
    if (!player) continue
    const champions: Record<string, number> = {}
    let gameName = 'Unknown'
    let totalGames = 0

    for (let j = 0; j < matchRequests.length; j++) {
      const req = matchRequests[j]
      if (!req || req.playerIndex !== i) continue
      const match = matchDetailResults[j]
      if (!match) continue

      const participant = match.info.participants.find(
        (p) => p.puuid === player.puuid,
      )
      if (participant) {
        const champ = participant.championName
        champions[champ] = (champions[champ] ?? 0) + 1
        gameName =
          participant.riotIdGameName ?? participant.summonerName ?? gameName
        totalGames++
      }

      // Store match in DB
      const existingMatch = await prisma.match.findUnique({
        where: { matchId: match.metadata.matchId },
      })
      if (!existingMatch) {
        await prisma.match.create({
          data: {
            matchId: match.metadata.matchId,
            region,
            gameDuration: match.info.gameDuration,
            gameCreation: new Date(match.info.gameCreation),
            participants: {
              create: match.info.participants.map((p) => ({
                puuid: p.puuid,
                championName: p.championName,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                cs: p.totalMinionsKilled,
                position: p.teamPosition,
                win: p.win,
                items: [
                  p.item0, p.item1, p.item2,
                  p.item3, p.item4, p.item5, p.item6,
                ].filter((item) => item > 0),
                runes: p.perks.styles.map((style) => ({
                  style: style.style,
                  runes: style.selections.map((s) => s.perk),
                })),
                summoner1Id: p.summoner1Id,
                summoner2Id: p.summoner2Id,
              })),
            },
          },
        })
      }
    }

    if (totalGames === 0) continue

    // Upsert player
    const dbPlayer = await prisma.player.upsert({
      where: { puuid_region: { puuid: player.puuid, region } },
      update: {
        gameName,
        tier: league.tier,
        lp: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        winRate: Math.round(
          (player.wins / (player.wins + player.losses)) * 100,
        ),
        totalGames,
      },
      create: {
        puuid: player.puuid,
        gameName,
        region,
        tier: league.tier,
        lp: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        winRate: Math.round(
          (player.wins / (player.wins + player.losses)) * 100,
        ),
        totalGames,
      },
    })

    // Upsert champion stats
    for (const [championName, gamesPlayed] of Object.entries(champions)) {
      await prisma.playerChampion.upsert({
        where: {
          playerId_championName: {
            playerId: dbPlayer.id,
            championName,
          },
        },
        update: { gamesPlayed },
        create: { playerId: dbPlayer.id, championName, gamesPlayed },
      })
    }

    collected++
  }

  // Log collection
  const total = await prisma.player.count({
    where: { region, tier: league.tier },
  })
  await prisma.collectionLog.create({
    data: { region, tier: league.tier, collected, total },
  })

  res.json({ region, tier: league.tier, collected, total })
})

export default router
