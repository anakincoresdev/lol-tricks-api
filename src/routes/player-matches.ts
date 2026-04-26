import { Router } from 'express'
import { prisma } from '../prisma.js'

const router = Router()

/**
 * @swagger
 * /api/riot/player-matches:
 *   get:
 *     summary: Get a player's recent ranked matches across all champions
 *     description: |
 *       Reads the latest 20 ranked-solo matches for a PUUID from the
 *       local Postgres (Match + MatchParticipant), across all champions,
 *       with full build data per match plus all 10 participants. Account
 *       header fields (riot id, profile icon, rank) are pulled from the
 *       tracked Player row — no Riot calls.
 *     tags: [Matches]
 *     parameters:
 *       - in: query
 *         name: puuid
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *           default: euw
 *     responses:
 *       200:
 *         description: Player match history across all champions
 *       400:
 *         description: Missing puuid
 */
router.get('/player-matches', async (req, res) => {
  const puuid = (req.query['puuid'] as string) ?? ''
  const region = (req.query['region'] as string) ?? 'euw'

  if (!puuid) {
    res.status(400).json({ error: 'puuid is required.' })
    return
  }

  // Header fields come from the tracked Player row. For non-tracked
  // puuids this is null — we still render the page, just without the
  // rank chip and with a placeholder profile icon.
  const player = await prisma.player
    .findFirst({
      where: { puuid, region },
      select: {
        gameName: true,
        tier: true,
        rank: true,
        lp: true,
        profileIconId: true,
      },
    })
    .catch(() => null)

  // The target player's 20 most recent ranked-solo matches. `queueId`
  // on Match is already 420 by default (deep-backfill only ingests
  // solo queue) but we filter explicitly so future queue additions
  // don't silently change this route's behaviour.
  const myRows = await prisma.matchParticipant.findMany({
    where: {
      puuid,
      match: { queueId: 420 },
    },
    orderBy: { match: { gameCreation: 'desc' } },
    take: 20,
    include: { match: true },
  })

  const matchIds = myRows.map((r) => r.matchId)

  // All 10 rosters in a single round-trip. Grouping client-side is
  // cheaper than 20 separate SELECTs.
  const allParticipants =
    matchIds.length > 0
      ? await prisma.matchParticipant.findMany({
          where: { matchId: { in: matchIds } },
          select: {
            matchId: true,
            puuid: true,
            championName: true,
            kills: true,
            deaths: true,
            assists: true,
            cs: true,
            position: true,
            win: true,
          },
        })
      : []

  // Enrich participant rows with riot-id#tag from the Player table for
  // anyone we also track. Everyone else stays 'Unknown' — we don't
  // call Riot from this route, period.
  const participantPuuids = Array.from(
    new Set(allParticipants.map((p) => p.puuid)),
  )
  const trackedPlayers =
    participantPuuids.length > 0
      ? await prisma.player.findMany({
          where: { puuid: { in: participantPuuids } },
          select: { puuid: true, gameName: true },
        })
      : []
  const nameByPuuid = new Map(
    trackedPlayers.map((p) => [p.puuid, p.gameName]),
  )

  const participantsByMatchId = new Map<string, typeof allParticipants>()
  for (const p of allParticipants) {
    const arr = participantsByMatchId.get(p.matchId) ?? []
    arr.push(p)
    participantsByMatchId.set(p.matchId, arr)
  }

  const matches = myRows.map((row) => {
    const items = Array.isArray(row.items) ? (row.items as number[]) : []
    const runes = Array.isArray(row.runes)
      ? (row.runes as { style: number; runes: number[] }[])
      : []
    const roster = (participantsByMatchId.get(row.matchId) ?? []).map((pp) => ({
      puuid: pp.puuid,
      gameName: nameByPuuid.get(pp.puuid) ?? 'Unknown',
      championName: pp.championName,
      kills: pp.kills,
      deaths: pp.deaths,
      assists: pp.assists,
      cs: pp.cs,
      position: pp.position,
      win: pp.win,
    }))

    return {
      matchId: row.match.matchId,
      championName: row.championName,
      win: row.win,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      items,
      runes,
      summoner1Id: row.summoner1Id,
      summoner2Id: row.summoner2Id,
      cs: row.cs,
      gameDuration: row.match.gameDuration,
      gameCreation: row.match.gameCreation.getTime(),
      position: row.position,
      participants: roster,
    }
  })

  res.json({
    puuid,
    region,
    gameName: player?.gameName ?? 'Unknown',
    profileIconId: player?.profileIconId ?? null,
    tier: player?.tier ?? null,
    rank: player?.rank ?? null,
    lp: player?.lp ?? null,
    matches,
  })
})

export default router
