import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  delay,
} from '../services/riot-client.js'
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

/**
 * @swagger
 * /api/riot/otp:
 *   get:
 *     summary: Find one-trick players
 *     description: Analyzes top players' recent matches to identify one-trick-ponies (35%+ games on one champion).
 *     tags: [OTP]
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
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *           maximum: 10
 *         description: Number of top players to analyze
 *     responses:
 *       200:
 *         description: List of OTP players
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 region:
 *                   type: string
 *                 tier:
 *                   type: string
 *                 otpThreshold:
 *                   type: integer
 *                 players:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       puuid:
 *                         type: string
 *                       gameName:
 *                         type: string
 *                       mainChampion:
 *                         type: string
 *                       otpPercent:
 *                         type: integer
 *                       lp:
 *                         type: integer
 */
router.get('/otp', async (req, res) => {
  const region = (req.query['region'] as string) ?? 'euw'
  const tier = (req.query['tier'] as string) ?? 'challenger'
  const limit = Math.min(Number(req.query['limit']) || 5, 10)

  if (!VALID_TIERS.includes(tier)) {
    res.status(400).json({
      error: 'Invalid tier. Must be: challenger, grandmaster, or master.',
    })
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
    .slice(0, limit)

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
    players: otpPlayers,
  })
})

export default router
