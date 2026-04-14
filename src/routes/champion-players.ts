import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  batchRequests,
  delay,
  getChampionNumericId,
  getChampionNameById,
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
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

router.get('/champion-players', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const region = (req.query['region'] as string) ?? 'euw'
  const forceRefresh = req.query['refresh'] === 'true'

  if (!champion) {
    res.status(400).json({ error: 'Champion parameter is required.' })
    return
  }

  const championNumericId = await getChampionNumericId(champion)
  if (!championNumericId) {
    res.status(400).json({ error: `Unknown champion: ${champion}` })
    return
  }

  // Try DB first: find players with mastery on this champion
  if (!forceRefresh) {
    const cachedMasteries = await prisma.championMastery.findMany({
      where: {
        championId: championNumericId,
        region,
        masteryPoints: { gte: MIN_MASTERY_POINTS },
        updatedAt: { gte: new Date(Date.now() - CACHE_TTL_MS) },
      },
      orderBy: { masteryPoints: 'desc' },
      take: 20,
    })

    if (cachedMasteries.length > 0) {
      // Get player info for these puuids
      const players = await prisma.player.findMany({
        where: {
          puuid: { in: cachedMasteries.map((m) => m.puuid) },
          region,
        },
      })
      const playerMap = new Map(players.map((p) => [p.puuid, p]))

      const result = cachedMasteries
        .map((m) => {
          const player = playerMap.get(m.puuid)
          return player
            ? {
                puuid: m.puuid,
                gameName: player.gameName,
                tier: player.tier,
                lp: player.lp,
                wins: player.wins,
                losses: player.losses,
                winRate: player.winRate,
                masteryPoints: m.masteryPoints,
                masteryLevel: m.masteryLevel,
              }
            : null
        })
        .filter(Boolean)
        .sort((a, b) => b!.lp - a!.lp)

      if (result.length > 0) {
        res.json({ champion, region, source: 'cache', players: result })
        return
      }
    }
  }

  // Fallback: Riot API
  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)

  const tiers = ['challenger', 'grandmaster', 'master'] as const
  const leagueResults = await Promise.all(
    tiers.map((t) =>
      riotFetch<LeagueList>(
        platformHost,
        `/lol/league/v4/${t}leagues/by-queue/RANKED_SOLO_5x5`,
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

  // Use /top?count=5 instead of per-champion query — fewer wasted requests
  const masteryResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<ChampionMasteryDto[]>(
          platformHost,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/top?count=5`,
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
    const masteries = masteryResults[i]
    const entry = topPlayers[i]
    if (!entry || !masteries) continue

    const championMastery = masteries.find(
      (m) => m.championId === championNumericId,
    )
    if (championMastery && championMastery.championPoints >= MIN_MASTERY_POINTS) {
      matchedPlayers.push({ entry, mastery: championMastery })
    }

    // Cache all top-5 masteries in DB
    for (const m of masteries) {
      const champName = await getChampionNameById(m.championId)
      if (!champName) continue
      void prisma.championMastery.upsert({
        where: {
          puuid_championId_region: {
            puuid: entry.puuid,
            championId: m.championId,
            region,
          },
        },
        update: {
          championName: champName,
          masteryPoints: m.championPoints,
          masteryLevel: m.championLevel,
        },
        create: {
          puuid: entry.puuid,
          championId: m.championId,
          championName: champName,
          masteryPoints: m.championPoints,
          masteryLevel: m.championLevel,
          region,
        },
      })
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
  }

  res.json({ champion, region, source: 'riot', players })
})

export default router
