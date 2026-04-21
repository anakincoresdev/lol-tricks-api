import 'dotenv/config'
import { prisma } from '../src/prisma.js'
import {
  getRegionalHost,
  riotFetch,
  batchRequests,
  delay,
  ApiError,
} from '../src/services/riot-client.js'
import type { MatchDto } from '../src/types/riot.js'

const WINDOW_DAYS = 60
const MATCHES_PER_PAGE = 100

interface CliArgs {
  region: string | null
  playerLimit: number | null
  maxMatches: number
  batchSize: number
  batchDelayMs: number
  betweenPlayersMs: number
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const get = (name: string): string | null => {
    const idx = args.findIndex((a) => a === `--${name}`)
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1] ?? null
    const eq = args.find((a) => a.startsWith(`--${name}=`))
    if (eq) return eq.split('=', 2)[1] ?? null
    return null
  }
  return {
    region: get('region'),
    playerLimit: get('limit') ? Number(get('limit')) : null,
    maxMatches: Number(get('max-matches') ?? 150),
    batchSize: Number(get('batch-size') ?? 3),
    batchDelayMs: Number(get('batch-delay') ?? 1200),
    betweenPlayersMs: Number(get('player-delay') ?? 500),
  }
}

async function backfillPlayer(
  puuid: string,
  region: string,
  cfg: CliArgs,
): Promise<{ fetched: number; created: number }> {
  const regionalHost = getRegionalHost(region)
  const startTime = Math.floor(
    (Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000,
  )

  const allIds: string[] = []
  let start = 0
  while (allIds.length < cfg.maxMatches) {
    const page = await riotFetch<string[]>(
      regionalHost,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${startTime}&start=${start}&count=${MATCHES_PER_PAGE}`,
    )
    if (page.length === 0) break
    allIds.push(...page)
    if (page.length < MATCHES_PER_PAGE) break
    start += MATCHES_PER_PAGE
    await delay(200)
  }

  const truncated = allIds.slice(0, cfg.maxMatches)
  if (truncated.length === 0) return { fetched: 0, created: 0 }

  const existing = await prisma.match.findMany({
    where: { matchId: { in: truncated } },
    select: { matchId: true },
  })
  const existingSet = new Set(existing.map((m) => m.matchId))
  const newIds = truncated.filter((id) => !existingSet.has(id))

  if (newIds.length === 0) return { fetched: truncated.length, created: 0 }

  const details = await batchRequests(
    newIds.map(
      (id) => () =>
        riotFetch<MatchDto>(regionalHost, `/lol/match/v5/matches/${id}`).catch(
          () => null as unknown as MatchDto,
        ),
    ),
    cfg.batchSize,
    cfg.batchDelayMs,
  )

  let created = 0
  for (let i = 0; i < newIds.length; i++) {
    const match = details[i]
    const matchId = newIds[i]
    if (!match || !matchId) continue
    try {
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
                p.item0,
                p.item1,
                p.item2,
                p.item3,
                p.item4,
                p.item5,
                p.item6,
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
      created++
    } catch {
      // Unique constraint race — another run stored it first. Ignore.
    }
  }

  return { fetched: truncated.length, created }
}

async function main(): Promise<void> {
  const cfg = parseArgs()

  const players = await prisma.player.findMany({
    where: {
      tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] },
      ...(cfg.region ? { region: cfg.region } : {}),
    },
    orderBy: [{ tier: 'asc' }, { lp: 'desc' }],
    select: { puuid: true, region: true, gameName: true, tier: true },
    ...(cfg.playerLimit ? { take: cfg.playerLimit } : {}),
  })

  console.log(
    `Backfilling ${players.length} Master+ players over ${WINDOW_DAYS}d ` +
      `(maxMatches=${cfg.maxMatches}, batchSize=${cfg.batchSize}, batchDelay=${cfg.batchDelayMs}ms).`,
  )

  let idx = 0
  let totalCreated = 0
  for (const player of players) {
    idx++
    try {
      const { fetched, created } = await backfillPlayer(
        player.puuid,
        player.region,
        cfg,
      )
      totalCreated += created
      console.log(
        `[${idx}/${players.length}] ${player.gameName} (${player.region} ${player.tier}) — fetched ${fetched}, created ${created}`,
      )
    } catch (e) {
      const msg =
        e instanceof ApiError ? `${e.statusCode} ${e.message}` : String(e)
      console.error(
        `[${idx}/${players.length}] ${player.gameName} (${player.region}) — error: ${msg}`,
      )
    }
    await delay(cfg.betweenPlayersMs)
  }

  console.log(`Done. Total new matches created: ${totalCreated}.`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
