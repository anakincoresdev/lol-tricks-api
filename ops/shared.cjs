// Shared helpers: env, Prisma client, Riot fetch with global token bucket.
// CommonJS so it works with plain `node` on any machine (no tsx needed).

// `override: true` makes .env win over pre-existing shell env vars. Without
// this, a stale `export RIOT_API_KEY=…` in the developer's zsh session
// silently shadows the fresh value in .env and the script keeps jamming a
// dead key against Riot, bailing with 401 until the user notices. Ops
// scripts only ever run locally, so there's no deploy-side downside:
// Vercel never has a .env file on disk (gitignored), so override has
// nothing to override with and the injected env vars pass through.
require('dotenv').config({ override: true })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

const PLATFORM_HOSTS = {
  euw: 'euw1.api.riotgames.com',
  na: 'na1.api.riotgames.com',
  kr: 'kr.api.riotgames.com',
}

const REGIONAL_HOSTS = {
  euw: 'europe.api.riotgames.com',
  na: 'americas.api.riotgames.com',
  kr: 'asia.api.riotgames.com',
}

function getPlatformHost(region) {
  return PLATFORM_HOSTS[region]
}
function getRegionalHost(region) {
  return REGIONAL_HOSTS[region]
}

// Resolve which env var to read the Riot key from.
//
// Priority (first match wins):
//   1. CLI flag --key=1|2|3 (or --key-var=NAME) on the script command line.
//      --key=1 → RIOT_API_KEY, --key=2 → RIOT_API_KEY_SECOND,
//      --key=3 → RIOT_API_KEY_THIRD. Works in any shell/OS because no
//      `export` is involved.
//   2. RIOT_KEY_VAR env var (legacy; useful for CI).
//   3. Default: RIOT_API_KEY.
//
// This lets you run 3 parallel backfill processes with 3 different keys
// without juggling shell-env exports, by just passing --key=N on each.
function resolveKeyVarName() {
  const KEY_SLOTS = {
    1: 'RIOT_API_KEY',
    first: 'RIOT_API_KEY',
    2: 'RIOT_API_KEY_SECOND',
    second: 'RIOT_API_KEY_SECOND',
    3: 'RIOT_API_KEY_THIRD',
    third: 'RIOT_API_KEY_THIRD',
  }
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=', 2)
    if (k === 'key' && v && KEY_SLOTS[v.toLowerCase()]) {
      return KEY_SLOTS[v.toLowerCase()]
    }
    if (k === 'key-var' && v) return v
  }
  return process.env.RIOT_KEY_VAR || 'RIOT_API_KEY'
}

const RIOT_KEY_VAR = resolveKeyVarName()
const RIOT_API_KEY = process.env[RIOT_KEY_VAR]
if (!RIOT_API_KEY) {
  console.error(
    `${RIOT_KEY_VAR} missing — add it to .env (or pass --key-var=OTHER_VAR).`,
  )
  process.exit(1)
}
console.log(
  `[riot] using key from $${RIOT_KEY_VAR} (${RIOT_API_KEY.slice(0, 10)}…)`,
)

// =====================================================================
// Token bucket rate limiter
// Dev-key default:
//   - 20 requests / 1 second
//   - 100 requests / 2 minutes
// We enforce the tighter 100/120s rule explicitly and stay at ~45 rpm
// to leave headroom for 429 spikes.
// =====================================================================

const RL_WINDOW_MS = 120_000 // 2 minutes
const RL_MAX_IN_WINDOW = Number(process.env.RL_MAX_IN_WINDOW || 90)
const RL_MIN_SPACING_MS = Number(process.env.RL_MIN_SPACING_MS || 100)

const requestTimestamps = []
let lastRequestAt = 0

async function waitForSlot() {
  while (true) {
    const now = Date.now()
    // prune old entries
    while (
      requestTimestamps.length > 0 &&
      now - requestTimestamps[0] > RL_WINDOW_MS
    ) {
      requestTimestamps.shift()
    }

    const spacingRemaining = RL_MIN_SPACING_MS - (now - lastRequestAt)
    if (spacingRemaining > 0) {
      await sleep(spacingRemaining)
      continue
    }

    if (requestTimestamps.length < RL_MAX_IN_WINDOW) {
      requestTimestamps.push(now)
      lastRequestAt = now
      return
    }

    const waitMs = RL_WINDOW_MS - (now - requestTimestamps[0]) + 50
    await sleep(Math.max(waitMs, 200))
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function riotFetch(host, path, opts = {}) {
  const url = `https://${host}${path}`
  const maxRetries = opts.maxRetries ?? 5
  let attempt = 0

  while (true) {
    await waitForSlot()
    let response
    try {
      response = await fetch(url, {
        headers: { 'X-Riot-Token': RIOT_API_KEY },
      })
    } catch (e) {
      if (attempt < maxRetries) {
        attempt++
        await sleep(1000 * attempt)
        continue
      }
      throw new ApiError(0, `Network: ${e.message}`)
    }

    if (response.ok) {
      return response.json()
    }

    const status = response.status

    // Rate limited — Riot tells us how long to wait.
    if (status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000
      console.warn(
        `[rate-limit] 429 on ${path} — sleeping ${waitMs}ms (attempt ${attempt + 1})`,
      )
      if (attempt < maxRetries) {
        attempt++
        await sleep(waitMs + 500)
        continue
      }
      throw new ApiError(429, 'Rate limit exceeded after retries')
    }

    // Transient 5xx — retry with backoff.
    if (status >= 500 && status < 600 && attempt < maxRetries) {
      attempt++
      await sleep(1000 * attempt)
      continue
    }

    if (status === 404) throw new ApiError(404, 'Not found')
    if (status === 401 || status === 403) {
      // Both statuses point at the same operational cause: the key in
      // .env is missing, malformed, or expired (dev keys live 24h).
      // 401 = server didn't get a usable key (header missing / value
      // looks bogus). 403 = key present but Riot rejected it.
      throw new ApiError(
        status,
        `Invalid/expired Riot API key (${status}) — regenerate at https://developer.riotgames.com/ and update .env RIOT_API_KEY`,
      )
    }
    throw new ApiError(status, `Riot ${status} ${response.statusText}: ${path}`)
  }
}

// =====================================================================
// DDragon: champion ID <-> name cache
// =====================================================================

let championByKey = null

async function loadChampions() {
  if (championByKey) return championByKey
  const versions = await (
    await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
  ).json()
  const latest = versions[0]
  const data = await (
    await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`,
    )
  ).json()
  championByKey = { byName: {}, byId: {}, all: [] }
  for (const c of Object.values(data.data)) {
    const id = parseInt(c.key, 10)
    championByKey.byName[c.id] = id
    championByKey.byId[id] = c.id
    championByKey.all.push(c.id)
  }
  return championByKey
}

// =====================================================================
// Progress logging
// =====================================================================

const fs = require('fs')
const path = require('path')
const LOG_DIR = path.join(__dirname, 'logs')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

function logLine(name, obj) {
  const line = `${new Date().toISOString()} ${JSON.stringify(obj)}\n`
  fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), line)
}

module.exports = {
  prisma,
  riotFetch,
  getPlatformHost,
  getRegionalHost,
  loadChampions,
  ApiError,
  sleep,
  logLine,
  LOG_DIR,
}
