import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  batchRequests,
  delay,
  getChampionNameById,
} from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import { config } from '../config.js'
import type {
  LeagueList,
  MatchDto,
  AccountDto,
  ChampionMasteryDto,
} from '../types/riot.js'

const router = Router()

const VALID_TIERS = ['challenger', 'grandmaster', 'master']

router.get('/collect', async (req, res) => {
  const region = (req.query['region'] as string) ?? 'euw'
  const tier = (req.query['tier'] as string) ?? 'challenger'
  const secret = req.query['secret'] as string | undefined
  const limit = Math.min(Number(req.query['limit']) || 50, 200)

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

  // 1. Fetch league — all players in tier (single request)
  const league = await riotFetch<LeagueList>(
    platformHost,
    `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`,
  )

  const topPlayers = league.entries
    .sort((a, b) => b.leaguePoints - a.leaguePoints)
    .slice(0, limit)

  // 2. Fetch account names in batches
  const accountResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<AccountDto>(
          regionalHost,
          `/riot/account/v1/accounts/by-puuid/${player.puuid}`,
        ),
    ),
    10,
    300,
  )

  await delay(200)

  // 3. Fetch top-5 champion mastery for each player
  const masteryResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<ChampionMasteryDto[]>(
          platformHost,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/top?count=5`,
        ),
    ),
    10,
    300,
  )

  await delay(200)

  // 4. Fetch match IDs in batches — grab 20 recent ranked games per player so
  // PlayerChampion stats reflect real mains, not just the last 5 games.
  const matchIdResults = await batchRequests(
    topPlayers.map(
      (player) => () =>
        riotFetch<string[]>(
          regionalHost,
          `/lol/match/v5/matches/by-puuid/${player.puuid}/ids?queue=420&count=20`,
        ),
    ),
    5,
    300,
  )

  // 5. Collect unique match IDs (skip already stored)
  const allMatchIds = new Set<string>()
  const playerMatchMap = new Map<number, string[]>()

  for (let i = 0; i < topPlayers.length; i++) {
    const matchIds = matchIdResults[i]
    if (!matchIds) continue
    const ids = matchIds.slice(0, 20)
    playerMatchMap.set(i, ids)
    for (const id of ids) allMatchIds.add(id)
  }

  // Check which matches already exist in DB
  const existingMatches = await prisma.match.findMany({
    where: { matchId: { in: [...allMatchIds] } },
    select: { matchId: true },
  })
  const existingSet = new Set(existingMatches.map((m) => m.matchId))
  const newMatchIds = [...allMatchIds].filter((id) => !existingSet.has(id))

  // 6. Fetch only new match details
  const matchDetailMap = new Map<string, MatchDto>()

  if (newMatchIds.length > 0) {
    const matchDetails = await batchRequests(
      newMatchIds.map(
        (matchId) => () =>
          riotFetch<MatchDto>(
            regionalHost,
            `/lol/match/v5/matches/${matchId}`,
          ),
      ),
      5,
      300,
    )

    for (let i = 0; i < newMatchIds.length; i++) {
      const detail = matchDetails[i]
      const matchId = newMatchIds[i]
      if (detail && matchId) matchDetailMap.set(matchId, detail)
    }
  }

  // 7. Store matches in DB
  for (const [matchId, match] of matchDetailMap) {
    await prisma.match.create({
      data: {
        matchId,
        region,
        queueId: match.info.queueId,
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

  // 8. Upsert players, champion stats, and mastery
  let collected = 0

  for (let i = 0; i < topPlayers.length; i++) {
    const player = topPlayers[i]
    if (!player) continue

    const account = accountResults[i]
    const gameName = account
      ? `${account.gameName}#${account.tagLine}`
      : 'Unknown'

    // Count champions only from matches NEW in this run. Matches we already
    // stored in a previous collect were already counted then, so re-counting
    // them here would double-count as we increment below.
    const champions: Record<string, number> = {}
    let newGames = 0
    const matchIds = playerMatchMap.get(i) ?? []

    for (const matchId of matchIds) {
      const match = matchDetailMap.get(matchId)
      if (!match) continue
      const participant = match.info.participants.find(
        (p) => p.puuid === player.puuid,
      )
      if (participant) {
        champions[participant.championName] =
          (champions[participant.championName] ?? 0) + 1
        newGames++
      }
    }

    // Upsert player — accumulate totalGames across runs.
    const winRate = Math.round(
      (player.wins / (player.wins + player.losses)) * 100,
    )
    const dbPlayer = await prisma.player.upsert({
      where: { puuid_region: { puuid: player.puuid, region } },
      update: {
        gameName,
        tier: league.tier,
        lp: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        winRate,
        hotStreak: player.hotStreak,
        totalGames: { increment: newGames },
      },
      create: {
        puuid: player.puuid,
        gameName,
        region,
        tier: league.tier,
        lp: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        winRate,
        hotStreak: player.hotStreak,
        totalGames: newGames,
      },
    })

    // Increment champion play stats so repeated runs build a richer picture
    // of each player's real pool instead of overwriting yesterday's count.
    for (const [championName, gamesPlayed] of Object.entries(champions)) {
      await prisma.playerChampion.upsert({
        where: {
          playerId_championName: { playerId: dbPlayer.id, championName },
        },
        update: { gamesPlayed: { increment: gamesPlayed } },
        create: { playerId: dbPlayer.id, championName, gamesPlayed },
      })
    }

    // Upsert champion mastery from top-5
    const masteries = masteryResults[i]
    if (masteries) {
      for (const m of masteries) {
        const champName = await getChampionNameById(m.championId)
        if (!champName) continue
        await prisma.championMastery.upsert({
          where: {
            puuid_championId_region: {
              puuid: player.puuid,
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
            puuid: player.puuid,
            championId: m.championId,
            championName: champName,
            masteryPoints: m.championPoints,
            masteryLevel: m.championLevel,
            region,
          },
        })
      }
    }

    collected++
  }

  // Log
  const total = await prisma.player.count({
    where: { region, tier: league.tier },
  })
  await prisma.collectionLog.create({
    data: { region, tier: league.tier, collected, total },
  })

  res.json({
    region,
    tier: league.tier,
    collected,
    total,
    newMatches: matchDetailMap.size,
  })
})

export default router
