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
  MatchDto,
} from '../types/riot.js'

const router = Router()

// Minimum mastery points we accept when we do hit Riot for a fresh fetch (used
// only in the non-cacheOnly fallback path).
const MIN_MASTERY_POINTS = 10_000

interface PlayerRuneInfo {
  keystone: number
  primaryStyle: number
  secondaryStyle: number
}

// Normalised lane identifier matching frontend ROLES config.
export type PlayerPosition =
  | 'top'
  | 'jungle'
  | 'mid'
  | 'adc'
  | 'support'
  | null

interface PlayerMatchMeta {
  runes: PlayerRuneInfo | null
  position: PlayerPosition
}

interface ChampionPlayerResult {
  puuid: string
  gameName: string
  region: string
  tier: string
  rank: string
  lp: number
  wins: number
  losses: number
  winRate: number
  masteryPoints: number
  masteryLevel: number
  runes: PlayerRuneInfo | null
  position: PlayerPosition
}

function mapTeamPosition(raw: string | undefined): PlayerPosition {
  switch ((raw ?? '').toUpperCase()) {
    case 'TOP':
      return 'top'
    case 'JUNGLE':
      return 'jungle'
    case 'MIDDLE':
      return 'mid'
    case 'BOTTOM':
      return 'adc'
    case 'UTILITY':
      return 'support'
    default:
      return null
  }
}

// Pull runes + position out of already-stored match participants. Used in the
// hot path so user requests never wait on Riot.
async function fetchPlayerMatchMetaFromDb(
  players: { puuid: string }[],
  championName: string,
): Promise<Map<string, PlayerMatchMeta>> {
  const metaMap = new Map<string, PlayerMatchMeta>()
  if (players.length === 0) return metaMap

  const puuids = players.map((p) => p.puuid)
  const rows = await prisma.matchParticipant.findMany({
    where: { puuid: { in: puuids }, championName },
    include: { match: { select: { gameCreation: true } } },
  })

  rows.sort(
    (a, b) => b.match.gameCreation.getTime() - a.match.gameCreation.getTime(),
  )

  for (const row of rows) {
    if (metaMap.has(row.puuid)) continue

    const rawRunes = row.runes as unknown as {
      style: number
      runes: number[]
    }[]
    let runes: PlayerRuneInfo | null = null
    if (Array.isArray(rawRunes) && rawRunes.length > 0) {
      const primary = rawRunes[0]
      const secondary = rawRunes[1]
      const keystone = primary?.runes?.[0]
      if (primary && keystone) {
        runes = {
          keystone,
          primaryStyle: primary.style,
          secondaryStyle: secondary?.style ?? 0,
        }
      }
    }

    metaMap.set(row.puuid, {
      runes,
      position: mapTeamPosition(row.position),
    })
  }

  return metaMap
}

async function fetchPlayerMatchMeta(
  players: { puuid: string }[],
  regionalHost: string,
  max: number,
): Promise<Map<string, PlayerMatchMeta>> {
  const metaMap = new Map<string, PlayerMatchMeta>()
  const slice = players.slice(0, max)
  if (slice.length === 0) return metaMap

  const recentIds = await batchRequests(
    slice.map(
      (p) =>
        () =>
          riotFetch<string[]>(
            regionalHost,
            `/lol/match/v5/matches/by-puuid/${p.puuid}/ids?queue=420&count=3`,
          ).catch(() => [] as string[]),
    ),
    10,
    200,
  )

  const matchSpecs: { puuid: string; matchId: string }[] = []
  slice.forEach((p, idx) => {
    const ids = recentIds[idx]
    if (ids && ids.length > 0 && ids[0]) {
      matchSpecs.push({ puuid: p.puuid, matchId: ids[0] })
    }
  })

  if (matchSpecs.length === 0) return metaMap

  await delay(150)

  const matches = await batchRequests(
    matchSpecs.map(
      (spec) =>
        () =>
          riotFetch<MatchDto>(
            regionalHost,
            `/lol/match/v5/matches/${spec.matchId}`,
          ).catch(() => null as unknown as MatchDto),
    ),
    10,
    200,
  )

  matches.forEach((match, idx) => {
    if (!match) return
    const spec = matchSpecs[idx]
    if (!spec) return
    const me = match.info.participants.find((p) => p.puuid === spec.puuid)
    if (!me) return

    const position = mapTeamPosition(me.teamPosition)

    let runes: PlayerRuneInfo | null = null
    if (me.perks && me.perks.styles.length > 0) {
      const primary =
        me.perks.styles.find((s) => s.description === 'primaryStyle') ??
        me.perks.styles[0]
      const secondary =
        me.perks.styles.find((s) => s.description === 'subStyle') ??
        me.perks.styles[1]
      const keystonePerk = primary?.selections[0]?.perk

      if (primary && keystonePerk) {
        runes = {
          keystone: keystonePerk,
          primaryStyle: primary.style,
          secondaryStyle: secondary?.style ?? 0,
        }
      }
    }

    metaMap.set(spec.puuid, { runes, position })
  })

  return metaMap
}

async function getChampionPlayersForRegion(
  champion: string,
  championNumericId: number,
  region: string,
  forceRefresh: boolean,
  withRunes: boolean,
  cacheOnly: boolean,
): Promise<{ source: 'cache' | 'riot'; players: ChampionPlayerResult[] }> {
  const regionalHost = getRegionalHost(region)

  // Try DB first. We join PlayerChampion (how many games the player actually
  // played on this champion) with Player (rank, LP, win-rate) and optionally
  // with ChampionMastery for mastery points/level display. This gives us far
  // better coverage than relying on mastery alone.
  if (!forceRefresh) {
    const championRows = await prisma.playerChampion.findMany({
      where: {
        championName: champion,
        gamesPlayed: { gte: 1 },
        player: { region },
      },
      include: { player: true },
      orderBy: { gamesPlayed: 'desc' },
      take: 50,
    })

    if (championRows.length > 0) {
      const puuids = championRows.map((r) => r.player.puuid)

      const masteries = await prisma.championMastery.findMany({
        where: {
          championId: championNumericId,
          region,
          puuid: { in: puuids },
        },
      })
      const masteryByPuuid = new Map(masteries.map((m) => [m.puuid, m]))

      const base: ChampionPlayerResult[] = championRows.map((row) => {
        const player = row.player
        const mastery = masteryByPuuid.get(player.puuid)
        return {
          puuid: player.puuid,
          gameName: player.gameName,
          region,
          tier: player.tier,
          rank: player.rank ?? 'I',
          lp: player.lp,
          wins: player.wins,
          losses: player.losses,
          winRate: player.winRate,
          masteryPoints: mastery?.masteryPoints ?? 0,
          masteryLevel: mastery?.masteryLevel ?? 0,
          runes: null,
          position: null,
        }
      })

      base.sort((a, b) => b.lp - a.lp)

      if (withRunes) {
        const metaMap = cacheOnly
          ? await fetchPlayerMatchMetaFromDb(base, champion)
          : await fetchPlayerMatchMeta(base, regionalHost, 15)
        for (const p of base) {
          const meta = metaMap.get(p.puuid)
          p.runes = meta?.runes ?? null
          p.position = meta?.position ?? null
        }
      }
      return { source: 'cache', players: base }
    }
  }

  // Cache miss: short-circuit in cacheOnly mode so user requests stay fast.
  if (cacheOnly) {
    return { source: 'cache', players: [] }
  }

  // Fallback: Riot API
  const platformHost = getPlatformHost(region)

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

  const topPlayers = allEntries.slice(0, 300)

  await delay(200)

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

  matchedPlayers.sort(
    (a, b) => b.mastery.championPoints - a.mastery.championPoints,
  )
  const toResolve = matchedPlayers.slice(0, 50)

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

  const base: ChampionPlayerResult[] = []
  for (let i = 0; i < toResolve.length; i++) {
    const item = toResolve[i]
    if (!item) continue
    const { entry, mastery } = item
    const account = accountResults[i]
    const gameName = account
      ? `${account.gameName}#${account.tagLine}`
      : 'Unknown'

    base.push({
      puuid: entry.puuid,
      gameName,
      region,
      tier: entry.tierName,
      rank: entry.rank ?? 'I',
      lp: entry.leaguePoints,
      wins: entry.wins,
      losses: entry.losses,
      winRate: Math.round((entry.wins / (entry.wins + entry.losses)) * 100),
      masteryPoints: mastery.championPoints,
      masteryLevel: mastery.championLevel,
      runes: null,
      position: null,
    })
  }

  if (withRunes && base.length > 0) {
    const metaMap = await fetchPlayerMatchMeta(base, regionalHost, 15)
    for (const p of base) {
      const meta = metaMap.get(p.puuid)
      p.runes = meta?.runes ?? null
      p.position = meta?.position ?? null
    }
  }

  return { source: 'riot', players: base }
}

// Single region
router.get('/champion-players', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const region = (req.query['region'] as string) ?? 'euw'
  const forceRefresh = req.query['refresh'] === 'true'
  const withRunes = req.query['runes'] !== 'false'
  // Default to cache-only: user requests are served from DB populated by cron.
  // Pass ?cacheOnly=false to force a live Riot fetch (slow, may time out).
  const cacheOnly = req.query['cacheOnly'] !== 'false'

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
    withRunes,
    cacheOnly,
  )

  res.json({ champion, region, ...result })
})

// Multi-region: ?champion=Ahri&regions=euw,na,kr
router.get('/champion-players/multi', async (req, res) => {
  const champion = (req.query['champion'] as string) ?? ''
  const regionsParam = (req.query['regions'] as string) ?? ''
  const forceRefresh = req.query['refresh'] === 'true'
  const withRunes = req.query['runes'] !== 'false'
  const cacheOnly = req.query['cacheOnly'] !== 'false'

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

  const results = await Promise.allSettled(
    regions.map((region) =>
      getChampionPlayersForRegion(
        champion,
        championNumericId,
        region,
        forceRefresh,
        withRunes,
        cacheOnly,
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
    .sort((a, b) => b.lp - a.lp)

  res.json({
    champion,
    regions,
    byRegion,
    allPlayers,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  })
})

export default router
