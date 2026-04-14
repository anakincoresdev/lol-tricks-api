import { config } from '../config.js'

const PLATFORM_HOSTS: Record<string, string> = {
  br: 'br1.api.riotgames.com',
  eune: 'eun1.api.riotgames.com',
  euw: 'euw1.api.riotgames.com',
  jp: 'jp1.api.riotgames.com',
  kr: 'kr.api.riotgames.com',
  lan: 'la1.api.riotgames.com',
  las: 'la2.api.riotgames.com',
  na: 'na1.api.riotgames.com',
  oce: 'oc1.api.riotgames.com',
  tr: 'tr1.api.riotgames.com',
  ru: 'ru.api.riotgames.com',
}

const REGIONAL_HOSTS: Record<string, string> = {
  br: 'americas.api.riotgames.com',
  na: 'americas.api.riotgames.com',
  lan: 'americas.api.riotgames.com',
  las: 'americas.api.riotgames.com',
  oce: 'americas.api.riotgames.com',
  kr: 'asia.api.riotgames.com',
  jp: 'asia.api.riotgames.com',
  euw: 'europe.api.riotgames.com',
  eune: 'europe.api.riotgames.com',
  tr: 'europe.api.riotgames.com',
  ru: 'europe.api.riotgames.com',
}

export function getPlatformHost(region: string): string {
  return PLATFORM_HOSTS[region] ?? 'euw1.api.riotgames.com'
}

export function getRegionalHost(region: string): string {
  return REGIONAL_HOSTS[region] ?? 'europe.api.riotgames.com'
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function riotFetch<T>(host: string, path: string): Promise<T> {
  const apiKey = config.riotApiKey
  const url = `https://${host}${path}`
  const maxRetries = 2

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { 'X-Riot-Token': apiKey },
    })

    if (response.ok) {
      return response.json() as Promise<T>
    }

    const status = response.status

    if (status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get('Retry-After')
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }

    if (status === 429) {
      throw new ApiError(429, 'Rate limit exceeded. Try again later.')
    }
    if (status === 403) {
      throw new ApiError(403, 'Invalid or expired API key.')
    }
    throw new ApiError(status, `Riot API error: ${response.statusText}`)
  }

  throw new ApiError(500, 'Unexpected error in riotFetch')
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function batchRequests<T>(
  fns: (() => Promise<T>)[],
  batchSize: number,
  delayMs: number,
): Promise<(T | null)[]> {
  const results: (T | null)[] = []
  for (let i = 0; i < fns.length; i += batchSize) {
    const batch = fns.slice(i, i + batchSize)
    const settled = await Promise.allSettled(batch.map((fn) => fn()))
    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : null)
    }
    if (i + batchSize < fns.length) {
      await delay(delayMs)
    }
  }
  return results
}

// DDragon: dynamic version + champion ID cache
let championIdCache: Record<string, number> | null = null
let championNameByIdCache: Record<number, string> | null = null
let ddCacheExpiry = 0

interface DDragonResponse {
  data: Record<string, { key: string; id: string; name: string }>
}

async function ensureDDragonCache(): Promise<void> {
  if (championIdCache && Date.now() < ddCacheExpiry) return

  // Fetch latest DDragon version
  const versionsRes = await fetch(
    'https://ddragon.leagueoflegends.com/api/versions.json',
  )
  const versions = (await versionsRes.json()) as string[]
  const latestVersion = versions[0]

  const res = await fetch(
    `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`,
  )
  const data = (await res.json()) as DDragonResponse

  championIdCache = {}
  championNameByIdCache = {}
  for (const champ of Object.values(data.data)) {
    const numId = parseInt(champ.key, 10)
    championIdCache[champ.id.toLowerCase()] = numId
    championNameByIdCache[numId] = champ.id
  }

  // Cache for 24 hours
  ddCacheExpiry = Date.now() + 24 * 60 * 60 * 1000
}

export async function getChampionNumericId(
  championName: string,
): Promise<number | null> {
  await ensureDDragonCache()
  return championIdCache?.[championName.toLowerCase()] ?? null
}

export async function getChampionNameById(
  championId: number,
): Promise<string | null> {
  await ensureDDragonCache()
  return championNameByIdCache?.[championId] ?? null
}
