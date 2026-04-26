// Backfill MatchParticipant.firstLegendaryId from Match-v5 timelines.
//
// Why a separate script: the main match ingest (deep-backfill.cjs) only
// stores each player's FINAL inventory (`p.item0..item6`), which loses
// purchase order. The first legendary item is a per-game signal that
// requires the timeline endpoint — one extra Riot call per match — so
// we run it after the base backfill and fill in the column.
//
// Resumable:
//   - State file ops/logs/backfill-timeline.state.json keeps a set of
//     processed matchIds. You can stop (Ctrl+C) and re-run; it picks up
//     where it left off.
//
// What counts as a "legendary" item:
//   - Terminal in the DDragon recipe tree (`into` empty/missing)
//   - Available on Summoner's Rift (`maps["11"] === true`)
//   - Total cost ≥ 2500g
//   - Not tagged Boots / Consumable / Trinket
//   That set is computed at start-up from the latest DDragon `item.json`
//   and cached in memory for the whole run.
//
// Usage:
//   node ops/backfill-timeline.cjs                     # all regions
//   node ops/backfill-timeline.cjs --region=euw
//   node ops/backfill-timeline.cjs --regions=euw,na
//   node ops/backfill-timeline.cjs --match-limit=500   # cap total matches
//   node ops/backfill-timeline.cjs --reset             # wipe state file
//   node ops/backfill-timeline.cjs --state-file=foo.json  # custom state file
//
// Parallel runs (3 keys, 3 regions — ~3x throughput):
//   RIOT_API_KEY=KEY1 node ops/backfill-timeline.cjs --region=euw &
//   RIOT_API_KEY=KEY2 node ops/backfill-timeline.cjs --region=na  &
//   RIOT_API_KEY=KEY3 node ops/backfill-timeline.cjs --region=kr  &
//   wait
// Each --region run gets its own state file (backfill-timeline.<region>.state.json)
// so the three processes don't clobber each other's progress.

const fs = require('fs')
const path = require('path')

const {
  prisma,
  riotFetch,
  getRegionalHost,
  logLine,
  ApiError,
  LOG_DIR,
} = require('./shared.cjs')

const WINDOW_DAYS = 60
const BATCH_SIZE = 500

// State file path is resolved at run-time from CLI flags so you can
// run multiple instances in parallel (one per region, each with its
// own RIOT_API_KEY) without stepping on each other's state. Default:
//   --region=euw          → ops/logs/backfill-timeline.euw.state.json
//   (no --region)         → ops/logs/backfill-timeline.state.json
//   --state-file=foo.json → absolute or relative custom path
function resolveStateFile(cfg) {
  if (cfg.stateFile) return path.resolve(cfg.stateFile)
  if (cfg.regions && cfg.regions.length === 1) {
    return path.join(LOG_DIR, `backfill-timeline.${cfg.regions[0]}.state.json`)
  }
  return path.join(LOG_DIR, 'backfill-timeline.state.json')
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return { processed: {} }
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return { processed: {} }
  }
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

function parseArgs() {
  const out = {
    regions: null, // null = no region filter
    matchLimit: null,
    reset: false,
    stateFile: null,
  }
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=', 2)
    if (k === 'region' && v) out.regions = [v]
    else if (k === 'regions' && v) out.regions = v.split(',')
    else if (k === 'match-limit' && v) out.matchLimit = Number(v)
    else if (k === 'reset') out.reset = true
    else if (k === 'state-file' && v) out.stateFile = v
  }
  return out
}

// Build the legendary-item Set from the latest DDragon patch. Using the
// latest patch is fine here even though the frontend pins 15.7.1 —
// DDragon item ids are stable across patches and only a handful of new
// items ship per patch. If a purchased id isn't in the set we simply
// skip it, which is the correct behaviour for components.
async function loadLegendarySet() {
  const versions = await (
    await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
  ).json()
  const latest = versions[0]
  const data = await (
    await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/item.json`,
    )
  ).json()

  const set = new Set()
  for (const [rawId, item] of Object.entries(data.data)) {
    const id = Number(rawId)
    const total = item.gold?.total ?? 0
    const hasInto = Array.isArray(item.into) && item.into.length > 0
    const tags = Array.isArray(item.tags) ? item.tags : []
    const isBoots = tags.includes('Boots')
    const isConsumable = tags.includes('Consumable')
    const isTrinket = tags.includes('Trinket')
    const onSr = item.maps?.['11'] === true

    if (
      onSr &&
      !hasInto &&
      !isBoots &&
      !isConsumable &&
      !isTrinket &&
      total >= 2500
    ) {
      set.add(id)
    }
  }

  return set
}

async function processMatch(match, legendarySet, state) {
  const regionalHost = getRegionalHost(match.region)
  if (!regionalHost) {
    state.processed[match.matchId] = true
    return { updated: 0, skipped: true }
  }

  let timeline
  try {
    timeline = await riotFetch(
      regionalHost,
      `/lol/match/v5/matches/${match.matchId}/timeline`,
    )
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
      // Timeline missing (very old match / bad id) — never retry.
      state.processed[match.matchId] = true
      return { updated: 0, skipped: true }
    }
    throw e
  }

  // Map participantId (1-10) -> puuid for this match.
  const idToPuuid = {}
  for (const p of timeline.info?.participants ?? []) {
    idToPuuid[p.participantId] = p.puuid
  }

  // Walk frames in order; first legendary ITEM_PURCHASED per puuid wins.
  const firstByPuuid = {}
  for (const frame of timeline.info?.frames ?? []) {
    for (const ev of frame.events ?? []) {
      if (ev.type !== 'ITEM_PURCHASED') continue
      if (!legendarySet.has(ev.itemId)) continue
      const puuid = idToPuuid[ev.participantId]
      if (!puuid) continue
      if (firstByPuuid[puuid] !== undefined) continue
      firstByPuuid[puuid] = ev.itemId
    }
  }

  let updated = 0
  for (const [puuid, itemId] of Object.entries(firstByPuuid)) {
    const res = await prisma.matchParticipant.updateMany({
      where: { matchId: match.id, puuid, firstLegendaryId: null },
      data: { firstLegendaryId: itemId },
    })
    updated += res.count
  }

  state.processed[match.matchId] = true
  return { updated, skipped: false }
}

async function main() {
  const cfg = parseArgs()
  const stateFile = resolveStateFile(cfg)
  const state = cfg.reset ? { processed: {} } : loadState(stateFile)
  if (cfg.reset) saveState(stateFile, state)

  const legendarySet = await loadLegendarySet()
  console.log(
    `[backfill-timeline] state file: ${stateFile}`,
  )
  console.log(
    `[backfill-timeline] legendary set size: ${legendarySet.size}`,
  )

  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const whereMatch = {
    gameCreation: { gte: windowStart },
    queueId: 420,
    participants: { some: { firstLegendaryId: null } },
    ...(cfg.regions ? { region: { in: cfg.regions } } : {}),
  }

  const total = await prisma.match.count({ where: whereMatch })
  console.log(
    `[backfill-timeline] ${total} matches pending (60d window, queue 420)${cfg.regions ? ' region=' + cfg.regions.join(',') : ''}`,
  )
  logLine('backfill-timeline', { event: 'start', total, regions: cfg.regions })

  let processed = 0
  let updatedTotal = 0
  const started = Date.now()

  // Cursor-paginated scan over Match.id (cuid — lexically sortable).
  let cursorId = null
  outer: while (true) {
    const matches = await prisma.match.findMany({
      where: {
        ...whereMatch,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, matchId: true, region: true },
    })
    if (matches.length === 0) break

    for (const m of matches) {
      cursorId = m.id

      if (state.processed[m.matchId]) continue
      processed++

      if (cfg.matchLimit && processed > cfg.matchLimit) {
        console.log('[backfill-timeline] --match-limit reached')
        break outer
      }

      try {
        const { updated } = await processMatch(m, legendarySet, state)
        updatedTotal += updated
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.status === 401 || e.status === 403)
        ) {
          // `shared.cjs` surfaces the actionable "regenerate" message
          // via ApiError.message — no reason to keep hammering the API
          // once the key is dead.
          console.error('API key dead — aborting.')
          saveState(stateFile, state)
          await prisma.$disconnect()
          return
        }
        logLine('backfill-timeline', {
          event: 'error',
          matchId: m.matchId,
          region: m.region,
          status: e.status,
          message: e.message,
        })
        console.warn(
          `[${m.region}] ${m.matchId}: ${e.status ?? ''} ${e.message}`,
        )
      }

      if (processed % 25 === 0) saveState(stateFile, state)
      if (processed % 10 === 0) {
        const elapsed = Math.round((Date.now() - started) / 1000)
        const rate = processed / Math.max(elapsed, 1)
        const eta = Math.round((total - processed) / Math.max(rate, 0.01))
        console.log(
          `[${processed}/${total}] updated=${updatedTotal} rate=${rate.toFixed(2)}/s ETA=${eta}s`,
        )
      }
    }

    saveState(stateFile, state)
  }

  saveState(stateFile, state)
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(
    `[backfill-timeline] done. Matches processed: ${processed}. Participants updated: ${updatedTotal}. Elapsed: ${elapsed}s`,
  )
  logLine('backfill-timeline', {
    event: 'done',
    processed,
    updatedTotal,
    elapsedSec: elapsed,
  })
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
