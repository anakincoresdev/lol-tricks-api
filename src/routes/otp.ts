import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  delay,
} from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import type { LeagueList, MatchDto } from '../types/riot.js'

const router = Router()

const VALID_TIERS = ['challenger', 'grandmaster', 'master']
const OTP_THRESHOLD = 35

interface OtpPlayer {
  puuid: string
  gameName: string
  tier: string
  lp: number
  wins: number
  losses: number
  winRate: number
  mainChampion: string
  mainChampionGames: number
  totalGames: number
  otpPercent: number
}

router.get('/otp', async (req, res) => {
  const region = (req.query['region'] as string) ?? 'euw'
  const tier = (req.query['tier'] as string) ?? 'challenger'
  const limit = Math.min(Number(req.query['limit']) || 20, 50)
  const forceRefresh = req.query['refresh'] === 'true'

  if (!VALID_TIERS.includes(tier)) {
    res.status(400).json({
      error: 'Invalid tier. Must be: challenger, grandmaster, or master.',
    })
    return
  }

  // Try DB first: players with champion stats from collect
  if (!forceRefresh) {
    const dbPlayers = await prisma.player.findMany({
      where: { region, tier: tier.toUpperCase(), totalGames: { gt: 0 } },
      include: { champions: { orderBy: { gamesPlayed: 'desc' } } },
      orderBy: { lp: 'desc' },
      take: limit,
    })

    if (dbPlayers.length > 0) {
      const otpPlayers: OtpPlayer[] = dbPlayers
        .filter((p) => p.champions.length > 0)
        .map((p) => {
          const main = p.champions[0]!
          const otpPercent = Math.round(
            (main.gamesPlayed / p.totalGames) * 100,
          )
          return {
            puuid: p.puuid,
            gameName: p.gameName,
            tier: p.tier,
            lp: p.lp,
            wins: p.wins,
            losses: p.losses,
            winRate: p.winRate,
            mainChampion: main.championName,
            mainChampionGames: main.gamesPlayed,
            totalGames: p.totalGames,
            otpPercent,
          }
        })
        .sort((a, b) => b.otpPercent - a.otpPercent || b.lp - a.lp)

      res.json({
        region,
        tier,
        otpThreshold: OTP_THRESHOLD,
        source: 'cache',
        players: otpPlayers,
      })
      return
    }
  }

  // Fallback: live Riot API
  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)

  const league = await riotFetch<LeagueList>(
    platformHost,
    `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`,
  )

  const topPlayers = league.entries
    .sort((a, b) => b.leaguePoints - a.leaguePoints)
    .slice(0, Math.min(limit, 10)) // Limit live requests

  const otpPlayers: OtpPlayer[] = []

  for (const player of topPlayers) {
    try {
      const matchIds = await riotFetch<string[]>(
        regionalHost,
        `/lol/match/v5/matches/by-puuid/${player.puuid}/ids?queue=420&count=5`,
      )
      if (matchIds.length === 0) continue

      await delay(100)

      const matchDetails = await Promise.all(
        matchIds
          .slice(0, 3)
          .map((matchId) =>
            riotFetch<MatchDto>(
              regionalHost,
              `/lol/match/v5/matches/${matchId}`,
            ),
          ),
      )

      const championCount: Record<string, number> = {}
      for (const match of matchDetails) {
        const participant = match.info.participants.find(
          (p) => p.puuid === player.puuid,
        )
        if (participant) {
          const champ = participant.championName
          championCount[champ] = (championCount[champ] ?? 0) + 1
        }
      }

      let mainChampion = ''
      let maxGames = 0
      for (const [champ, count] of Object.entries(championCount)) {
        if (count > maxGames) {
          mainChampion = champ
          maxGames = count
        }
      }

      const totalGames = matchDetails.length
      const otpPercent = Math.round((maxGames / totalGames) * 100)

      const firstMatch = matchDetails[0]
      const participantData = firstMatch?.info.participants.find(
        (p) => p.puuid === player.puuid,
      )
      const gameName =
        participantData?.riotIdGameName ??
        participantData?.summonerName ??
        'Unknown'

      otpPlayers.push({
        puuid: player.puuid,
        gameName,
        tier: league.tier,
        lp: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        winRate: Math.round(
          (player.wins / (player.wins + player.losses)) * 100,
        ),
        mainChampion,
        mainChampionGames: maxGames,
        totalGames,
        otpPercent,
      })

      await delay(200)
    } catch {
      continue
    }
  }

  otpPlayers.sort((a, b) => b.otpPercent - a.otpPercent || b.lp - a.lp)

  res.json({
    region,
    tier,
    otpThreshold: OTP_THRESHOLD,
    source: 'riot',
    players: otpPlayers,
  })
})

export default router
