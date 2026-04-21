// Deep 60-day match backfill for Master+ players (EUW/NA/KR by default).
// This is the heavy script — it pulls every ranked-solo match for each
// tracked player in the window, which populates MatchParticipant and lets
// /champion-players/global return data for every champion those players
// have touched.
//
// Resumable:
//   - Progress is kept in ops/logs/deep-backfill.state.json (per-puuid cursor).
//   - You can stop the script (Ctrl+C) and re-run — it picks up where it left off.
//
// Rate-limit aware: uses the token-bucket riotFetch from shared.cjs which
// enforces dev-key 100-req / 2-min + 429-retry.
//
// Usage:
//   node ops/deep-backfill.cjs                  # all 3 regions, all Master+
//   node ops/deep-backfill.cjs --region=euw
//   node ops/deep-backfill.cjs --max-matches=80 # cap per-player match count
//   node ops/deep-backfill.cjs --player-limit=300

const fs = require('fs')
const path = require('path')

const {
  prisma,
  riotFetch,
  getRegionalHost,
  logLine,
  ApiError,
  sleep,
  LOG_DIR,
} = require('./shared.cjs')

const STATE_FILE = path.join(LOG_DIR, 'deep-backfill.state.json')
const WINDOW_DAYS = 60
const PAGE_SIZE = 100

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { cursors: {} }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { cursors: {} }
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function parseArgs() {
  const out = {
    regions: ['euw', 'na', 'kr'],
    maxMatchesPerPlayer: 120,
    playerLimit: null,
    reset: false,
  }
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=', 2)
    if (k === 'region' && v) out.regions = [v]
    else if (k === 'regions' && v) out.regions = v.split(',')
    else if (k === 'max-matches' && v) out.maxMatchesPerPlayer = Number(v)
    else if (k === 'player-limit' && v) out.playerLimit = Number(v)
    else if (k === 'reset') out.reset = true
  }
  return out
}

async function backfillPlayer(puuid, region, cfg, state) {
  const regionalHost = getRegionalHost(region)
  const cursorKey = `${region}:${puuid}`
  const cursor = state.cursors[cursorKey] || { start: 0, done: false }
  if (cursor.done) return { fetched: 0, created: 0, skipped: true }

  const startTime = Math.floor(
    (Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000,
  )

  const collectedIds = []
  let start = cursor.start
  while (collectedIds.length + cursor.start < cfg.maxMatchesPerPlayer) {
    let page
    try {
      page = await riotFetch(
        regionalHost,
        `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${startTime}&start=${start}&count=${PAGE_SIZE}`,
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        page = []
      } else {
        throw e
      }
    }
    if (!page.length) break
    collectedIds.push(...page)
    if (page.length < PAGE_SIZE) break
    start += PAGE_SIZE
  }

  const truncated = collectedIds.slice(0, cfg.maxMatchesPerPlayer)
  if (truncated.length === 0) {
    state.cursors[cursorKey] = { start, done: true }
    saveState(state)
    return { fetched: 0, created: 0 }
  }

  const existing = await prisma.match.findMany({
    where: { matchId: { in: truncated } },
    select: { matchId: true },
  })
  const existingSet = new Set(existing.map((m) => m.matchId))
  const newIds = truncated.filter((id) => !existingSet.has(id))

  let created = 0
  for (const id of newIds) {
    let match
    try {
      match = await riotFetch(regionalHost, `/lol/match/v5/matches/${id}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue
      throw e
    }
    if (!match || match.info.queueId !== 420) continue
    try {
      await prisma.match.create({
        data: {
          matchId: id,
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
                p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6,
              ].filter((x) => x > 0),
              runes: (p.perks?.styles ?? []).map((s) => ({
                style: s.style,
                runes: (s.selections ?? []).map((x) => x.perk),
              })),
              summoner1Id: p.summoner1Id || 0,
              summoner2Id: p.summoner2Id || 0,
            })),
          },
        },
      })
      created++
    } catch (e) {
      // P2002 unique-constraint race (another pass stored it first) — OK.
      if (!(e.code === 'P2002')) {
        console.warn(`[${region}] match ${id} write failed: ${e.message}`)
      }
    }
  }

  state.cursors[cursorKey] = {
    start: cursor.start + truncated.length,
    done: truncated.length < cfg.maxMatchesPerPlayer,
  }
  saveState(state)
  return { fetched: truncated.length, created }
}

async function main() {
  const cfg = parseArgs()
  const state = cfg.reset ? { cursors: {} } : loadState()
  if (cfg.reset) saveState(state)

  const players = await prisma.player.findMany({
    where: {
      tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] },
      region: { in: cfg.regions },
    },
    orderBy: [{ lp: 'desc' }],
    select: { puuid: true, region: true, gameName: true, tier: true, lp: true },
    ...(cfg.playerLimit ? { take: cfg.playerLimit } : {}),
  })

  console.log(
    `[deep-backfill] ${players.length} players across ${cfg.regions.join(',')} — max ${cfg.maxMatchesPerPlayer} matches each`,
  )
  logLine('deep-backfill', {
    event: 'start',
    players: players.length,
    regions: cfg.regions,
    maxMatchesPerPlayer: cfg.maxMatchesPerPlayer,
  })

  let idx = 0
  let totalCreated = 0
  const started = Date.now()
  for (const p of players) {
    idx++
    try {
      const { fetched, created, skipped } = await backfillPlayer(
        p.puuid,
        p.region,
        cfg,
        state,
      )
      totalCreated += created
      const elapsed = Math.round((Date.now() - started) / 1000)
      const rate = idx / Math.max(elapsed, 1)
      const eta = Math.round((players.length - idx) / Math.max(rate, 0.01))
      const status = skipped ? 'skip (done)' : `fetched=${fetched} created=${created}`
      console.log(
        `[${idx}/${players.length}] ${p.gameName} (${p.region} ${p.tier} LP=${p.lp}) — ${status} — total=${totalCreated} elapsed=${elapsed}s ETA=${eta}s`,
      )
      if (idx % 10 === 0) {
        logLine('deep-backfill', {
          event: 'progress',
          idx,
          total: players.length,
          totalCreated,
          elapsedSec: elapsed,
        })
      }
    } catch (e) {
      console.error(`[${idx}/${players.length}] ${p.gameName} — ${e.status || ''} ${e.message}`)
      logLine('deep-backfill', {
        event: 'error',
        puuid: p.puuid,
        region: p.region,
        status: e.status,
        message: e.message,
      })
      // 403 = dead key, no point in continuing
      if (e.status === 403) {
        console.error('API key dead — aborting.')
        break
      }
    }
  }

  console.log(
    `[deep-backfill] done. Matches created: ${totalCreated}. Elapsed: ${Math.round((Date.now() - started) / 1000)}s`,
  )
  logLine('deep-backfill', {
    event: 'done',
    totalCreated,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  })
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
