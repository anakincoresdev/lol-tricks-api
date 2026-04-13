import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  batchRequests,
  delay,
  getChampionNumericId,
} from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import type {
  LeagueList,
  LeagueEntry,
  ChampionMasteryDto,
  AccountDto,
} from '../types/riot.js'

const router = Router()

const MIN_MASTERY_POINTS = 50_000

router.get('/champion-players', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const region = (req.query['region'] as string) ?? 'euw'

  if (!champion) {
    res.status(400).json({ error: 'Champion parameter is required.' })
    return
  }

  const championNumericId = await getChampionNumericId(champion)
  if (!championNumericId) {
    res.status(400).json({ error: `Unknown champion: ${champion}` })
    return
  }

  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)

  // Fetch all 3 tiers in parallel
  const tiers = ['challenger', 'grandmaster', 'master'] as const
  const leagueResults = await Promise.all(
    tiers.map((tier) =>
      riotFetch<LeagueList>(
        platformHost,
        `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`,
      ),
    ),
  )

  const allEntries: (LeagueEntry & { tierName: string })[] = []
  for (const league of leagueResults) {
    for (const entry of league.entries) {
      allEntries.push({ ...entry, tierName: league.tier })
    }
  }
  allEntries.sort((a, b) => b.leaguePoints - a.leaguePoints)
  const topPlayers = allEntries.slice(0, 50)

  await delay(200)

  // Batch check champion mastery
  const masteryResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<ChampionMasteryDto>(
          platformHost,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/by-champion/${championNumericId}`,
        ),
    ),
    10,
    250,
  )

  const matchedPlayers: {
    entry: (typeof topPlayers)[number]
    mastery: ChampionMasteryDto
  }[] = []

  for (let i = 0; i < topPlayers.length; i++) {
    const mastery = masteryResults[i]
    const entry = topPlayers[i]
    if (entry && mastery && mastery.championPoints >= MIN_MASTERY_POINTS) {
      matchedPlayers.push({ entry, mastery })
    }
  }

  matchedPlayers.sort((a, b) => b.entry.leaguePoints - a.entry.leaguePoints)

  const toResolve = matchedPlayers.slice(0, 20)
  await delay(200)

  const accountResults = await batchRequests(
    toResolve.map(
      ({ entry }) =>
        () =>
          riotFetch<AccountDto>(
            regionalHost,
            `/riot/account/v1/accounts/by-puuid/${entry.puuid}`,
          ),
    ),
    10,
    250,
  )

  const players = []
  for (let i = 0; i < toResolve.length; i++) {
    const item = toResolve[i]
    if (!item) continue
    const { entry, mastery } = item
    const account = accountResults[i]
    const gameName = account
      ? `${account.gameName}#${account.tagLine}`
      : 'Unknown'

    players.push({
      puuid: entry.puuid,
      gameName,
      tier: entry.tierName,
      lp: entry.leaguePoints,
      wins: entry.wins,
      losses: entry.losses,
      winRate: Math.round((entry.wins / (entry.wins + entry.losses)) * 100),
      masteryPoints: mastery.championPoints,
      masteryLevel: mastery.championLevel,
    })

    // Cache mastery in DB
    await prisma.championMastery.upsert({
      where: {
        puuid_championId_region: {
          puuid: entry.puuid,
          championId: championNumericId,
          region,
        },
      },
      update: {
        masteryPoints: mastery.championPoints,
        masteryLevel: mastery.championLevel,
        championName: champion,
      },
      create: {
        puuid: entry.puuid,
        championId: championNumericId,
        championName: champion,
        masteryPoints: mastery.championPoints,
        masteryLevel: mastery.championLevel,
        region,
      },
    })
  }

  res.json({ champion, region, players })
})

export default router
