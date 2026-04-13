import { Router } from 'express'
import { getRegionalHost, riotFetch } from '../services/riot-client.js'
import { prisma } from '../prisma.js'
import type { MatchDto } from '../types/riot.js'

const router = Router()

/**
 * @swagger
 * /api/riot/matches/{puuid}:
 *   get:
 *     summary: Get player match history
 *     description: Returns recent ranked match IDs and detailed data for the first 5 matches.
 *     tags: [Matches]
 *     parameters:
 *       - in: path
 *         name: puuid
 *         required: true
 *         schema:
 *           type: string
 *         description: Player PUUID
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *           default: euw
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of match IDs to fetch
 *     responses:
 *       200:
 *         description: Match history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 puuid:
 *                   type: string
 *                 region:
 *                   type: string
 *                 matchIds:
 *                   type: array
 *                   items:
 *                     type: string
 *                 matches:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       matchId:
 *                         type: string
 *                       champion:
 *                         type: string
 *                       win:
 *                         type: boolean
 *                       kills:
 *                         type: integer
 *                       deaths:
 *                         type: integer
 *                       assists:
 *                         type: integer
 *                       items:
 *                         type: array
 *                         items:
 *                           type: integer
 *                       position:
 *                         type: string
 *                       cs:
 *                         type: integer
 *                       gameDuration:
 *                         type: integer
 */
router.get('/matches/:puuid', async (req, res) => {
  const { puuid } = req.params
  const region = (req.query['region'] as string) ?? 'euw'
  const count = Math.min(Number(req.query['count']) || 20, 100)

  if (!puuid) {
    res.status(400).json({ error: 'puuid is required.' })
    return
  }

  const host = getRegionalHost(region)

  const matchIds = await riotFetch<string[]>(
    host,
    `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=${count}`,
  )

  // Fetch first 5 match details
  const matchDetails = await Promise.all(
    matchIds
      .slice(0, 5)
      .map((matchId) =>
        riotFetch<MatchDto>(host, `/lol/match/v5/matches/${matchId}`),
      ),
  )

  const matches = matchDetails
    .map((match) => {
      const player = match.info.participants.find((p) => p.puuid === puuid)
      if (!player) return null

      return {
        matchId: match.metadata.matchId,
        champion: player.championName,
        win: player.win,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        items: [
          player.item0, player.item1, player.item2,
          player.item3, player.item4, player.item5, player.item6,
        ].filter((item) => item > 0),
        runes: player.perks.styles.map((style) => ({
          style: style.style,
          runes: style.selections.map((s) => s.perk),
        })),
        position: player.teamPosition,
        cs: player.totalMinionsKilled,
        gameDuration: match.info.gameDuration,
      }
    })
    .filter(Boolean)

  // Cache matches in DB
  for (const match of matchDetails) {
    const existing = await prisma.match.findUnique({
      where: { matchId: match.metadata.matchId },
    })
    if (!existing) {
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

  res.json({ puuid, region, matchIds, matches })
})

export default router
