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

const MIN_MASTERY_POINTS = 10_000 // Lowered from 50k — catches more players
const CACHE_TTL_MS = 30 * 60 * 1000

interface ChampionPlayerResult {
  puuid: string
  gameName: string
  region: string
  tier: string
  lp: number
  wins: number
  losses: number
  winRate: number
  masteryPoints: number
  masteryLevel: number
}

async function getChampionPlayersForRegion(
  champion: string,
  championNumericId: number,
  region: string,
  forceRefresh: boolean,
): Promise<{ source: 'cache' | 'riot'; players: ChampionPlayerResult[] }> {
  // Try DB first
  if (!forceRefresh) {
    const cachedMasteries = await prisma.championMastery.findMany({
      where: {
        championId: championNumericId,
        region,
        masteryPoints: { gte: MIN_MASTERY_POINTS },
        updatedAt: { gte: new Date(Date.now() - CACHE_TTL_MS) },
      },
      orderBy: { masteryPoints: 'desc' },
      take: 50,
    })

    if (cachedMasteries.length > 0) {
      const dbPlayers = await prisma.player.findMany({
        where: {
          puuid: { in: cachedMasteries.map((m) => m.puuid) },
          region,
        },
      })
      const playerMap = new Map(dbPlayers.map((p) => [p.puuid, p]))

      const result = cachedMasteries
        .map((m) => {
          const player = playerMap.get(m.puuid)
          return player
            ? {
                puuid: m.puuid,
                gameName: player.gameName,
                region,
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
        .filter((p): p is ChampionPlayerResult => p !== null)
        .sort((a, b) => b.lp - a.lp)

      if (result.length > 0) {
        return { source: 'cache', players: result }
      }
    }
  }

  // Fallback: Riot API
  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)

  // Fetch ALL players from all 3 apex tiers
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

  // Scan up to 300 players (all of Challenger + top Grandmaster)
  const topPlayers = allEntries.slice(0, 300)

  await delay(200)

  // Query mastery for the SPECIFIC champion, not top-5
  // This catches every player who has ever played this champion
  const masteryResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<ChampionMasteryDto>(
          platformHost,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/by-champion/${championNumericId}`,
        ).catch(() => null as unknown as ChampionMasteryDto),
    ),
    10,
    300,
  )

  const matchedPlayers: {
    entry: (typeof topPlayers)[number]
    mastery: ChampionMasteryDto
  }[] = []

  for (let i = 0; i < topPlayers.length; i++) {
    const mastery = masteryResults[i]
    const entry = topPlayers[i]
    if (!entry || !mastery || !mastery.championPoints) continue

    if (mastery.championPoints >= MIN_MASTERY_POINTS) {
      matchedPlayers.push({ entry, mastery })
    }

    // Cache in DB
    void prisma.championMastery.upsert({
      where: {
        puuid_championId_region: {
          puuid: entry.puuid,
          championId: championNumericId,
          region,
        },
      },
      update: {
        championName: champion,
        masteryPoints: mastery.championPoints,
        masteryLevel: mastery.championLevel,
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

  // Sort by mastery points descending
  matchedPlayers.sort((a, b) => b.mastery.championPoints - a.mastery.championPoints)
  const toResolve = matchedPlayers.slice(0, 50)

  await delay(200)

  // Fetch display names
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

  const players: ChampionPlayerResult[] = []
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
      region,
      tier: entry.tierName,
      lp: entry.leaguePoints,
      wins: entry.wins,
      losses: entry.losses,
      winRate: Math.round((entry.wins / (entry.wins + entry.losses)) * 100),
      masteryPoints: mastery.championPoints,
      masteryLevel: mastery.championLevel,
    })
  }

  return { source: 'riot', players }
}

// Single region
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

  const result = await getChampionPlayersForRegion(
    champion,
    championNumericId,
    region,
    forceRefresh,
  )

  res.json({ champion, region, ...result })
})

// Multi-region: ?champion=Ahri&regions=euw,na,kr
router.get('/champion-players/multi', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const regionsParam = (req.query['regions'] as string) ?? ''
  const forceRefresh = req.query['refresh'] === 'true'

  if (!champion) {
    res.status(400).json({ error: 'Champion parameter is required.' })
    return
  }

  if (!regionsParam) {
    res.status(400).json({
      error: 'Regions parameter is required. Example: regions=euw,na,kr',
    })
    return
  }

  const championNumericId = await getChampionNumericId(champion)
  if (!championNumericId) {
    res.status(400).json({ error: `Unknown champion: ${champion}` })
    return
  }

  const regions = regionsParam.split(',').map((r) => r.trim().toLowerCase())

  if (regions.length > 11) {
    res.status(400).json({ error: 'Maximum 11 regions allowed.' })
    return
  }

  // Fetch all regions in parallel
  const results = await Promise.allSettled(
    regions.map((region) =>
      getChampionPlayersForRegion(
        champion,
        championNumericId,
        region,
        forceRefresh,
      ).then((result) => ({ region, ...result })),
    ),
  )

  const byRegion: Record<
    string,
    { source: 'cache' | 'riot'; players: ChampionPlayerResult[] }
  > = {}
  const errors: Record<string, string> = {}

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { region, source, players } = result.value
      byRegion[region] = { source, players }
    } else {
      const idx = results.indexOf(result)
      const region = regions[idx] ?? 'unknown'
      errors[region] =
        result.reason instanceof Error
          ? result.reason.message
          : 'Unknown error'
    }
  }

  const allPlayers = Object.values(byRegion)
    .flatMap((r) => r.players)
    .sort((a, b) => b.masteryPoints - a.masteryPoints)

  res.json({
    champion,
    regions,
    byRegion,
    allPlayers,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  })
})

export default router
