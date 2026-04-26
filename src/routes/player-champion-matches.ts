import { Router } from 'express'
import {
  getPlatformHost,
  getRegionalHost,
  riotFetch,
  delay,
  getChampionNumericId,
} from '../services/riot-client.js'
import type { MatchDto, AccountDto } from '../types/riot.js'

const router = Router()

/**
 * @swagger
 * /api/riot/player-champion-matches:
 *   get:
 *     summary: Get player's matches on a specific champion
 *     description: Fetches up to 8 recent ranked matches where the player played a specific champion, with full build data.
 *     tags: [Matches]
 *     parameters:
 *       - in: query
 *         name: puuid
 *         required: true
 *         schema:
 *           type: string
 *         description: Player PUUID
 *       - in: query
 *         name: champion
 *         required: true
 *         schema:
 *           type: string
 *         description: Champion name (e.g. Yasuo)
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *           default: euw
 *     responses:
 *       200:
 *         description: Champion-specific match history with mastery info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 puuid:
 *                   type: string
 *                 champion:
 *                   type: string
 *                 region:
 *                   type: string
 *                 gameName:
 *                   type: string
 *                 masteryPoints:
 *                   type: integer
 *                 masteryLevel:
 *                   type: integer
 *                 matches:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       matchId:
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
 *                       runes:
 *                         type: array
 *                       position:
 *                         type: string
 *                       gameDuration:
 *                         type: integer
 *       400:
 *         description: Missing puuid or champion
 */
router.get('/player-champion-matches', async (req, res) => {
  const puuid = (req.query['puuid'] as string) ?? ''
  const champion = (req.query['champion'] as string) ?? ''
  const region = (req.query['region'] as string) ?? 'euw'

  if (!puuid) {
    res.status(400).json({ error: 'puuid is required.' })
    return
  }
  if (!champion) {
    res.status(400).json({ error: 'champion is required.' })
    return
  }

  const regionalHost = getRegionalHost(region)
  const platformHost = getPlatformHost(region)

  const account = await riotFetch<AccountDto>(
    regionalHost,
    `/riot/account/v1/accounts/by-puuid/${puuid}`,
  ).catch(() => null)

  const gameName = account
    ? `${account.gameName}#${account.tagLine}`
    : 'Unknown'

  await delay(200)

  const matchIds = await riotFetch<string[]>(
    regionalHost,
    `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=20`,
  )

  // Participant summary for the 10 players in a match. Kept separate
  // from the top-level match row (which holds the target player's
  // build) so the client can render a team roster without rehashing
  // every field. `gameName` is formatted `riotIdGameName#riotIdTagline`
  // to match how we display player names elsewhere; falls back to the
  // legacy `summonerName` for old Riot payloads where riotId fields may
  // be empty strings.
  interface ParticipantSummary {
    puuid: string
    gameName: string
    championName: string
    kills: number
    deaths: number
    assists: number
    cs: number
    position: string
    win: boolean
  }

  const championMatches: {
    matchId: string
    win: boolean
    kills: number
    deaths: number
    assists: number
    items: number[]
    runes: { style: number; runes: number[] }[]
    summoner1Id: number
    summoner2Id: number
    cs: number
    gameDuration: number
    gameCreation: number
    position: string
    participants: ParticipantSummary[]
  }[] = []

  // Format a Riot-id display name. Prefer the new `riotIdGameName#tag`
  // shape, fall back to the legacy summonerName when the new fields
  // come back empty (happens for very old matches or region-migrated
  // accounts where Riot hasn't populated the new identity yet).
  function formatRiotId(p: {
    riotIdGameName: string
    riotIdTagline: string
    summonerName: string
  }): string {
    if (p.riotIdGameName && p.riotIdTagline) {
      return `${p.riotIdGameName}#${p.riotIdTagline}`
    }
    if (p.riotIdGameName) return p.riotIdGameName
    return p.summonerName || 'Unknown'
  }

  const targetCount = 8

  for (const matchId of matchIds) {
    if (championMatches.length >= targetCount) break

    await delay(300)

    let match: MatchDto
    try {
      match = await riotFetch<MatchDto>(
        regionalHost,
        `/lol/match/v5/matches/${matchId}`,
      )
    } catch {
      continue
    }

    const player = match.info.participants.find((p) => p.puuid === puuid)
    if (!player) continue
    if (player.championName.toLowerCase() !== champion.toLowerCase()) continue

    const participants: ParticipantSummary[] = match.info.participants.map(
      (pp) => ({
        puuid: pp.puuid,
        gameName: formatRiotId(pp),
        championName: pp.championName,
        kills: pp.kills,
        deaths: pp.deaths,
        assists: pp.assists,
        cs: pp.totalMinionsKilled,
        position: pp.teamPosition,
        win: pp.win,
      }),
    )

    championMatches.push({
      matchId: match.metadata.matchId,
      win: player.win,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      items: [
        player.item0, player.item1, player.item2,
        player.item3, player.item4, player.item5, player.item6,
      ],
      runes: player.perks.styles.map((style) => ({
        style: style.style,
        runes: style.selections.map((s) => s.perk),
      })),
      summoner1Id: player.summoner1Id,
      summoner2Id: player.summoner2Id,
      cs: player.totalMinionsKilled,
      gameDuration: match.info.gameDuration,
      gameCreation: match.info.gameCreation,
      position: player.teamPosition,
      participants,
    })
  }

  // Fetch champion mastery
  let masteryPoints = 0
  let masteryLevel = 0

  try {
    const numericId = await getChampionNumericId(champion)
    if (numericId) {
      await delay(200)
      const mastery = await riotFetch<{
        championPoints: number
        championLevel: number
      }>(
        platformHost,
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/by-champion/${numericId}`,
      )
      masteryPoints = mastery.championPoints
      masteryLevel = mastery.championLevel
    }
  } catch {
    // Mastery fetch is optional
  }

  res.json({
    puuid,
    champion,
    region,
    gameName,
    masteryPoints,
    masteryLevel,
    matches: championMatches,
  })
})

export default router
