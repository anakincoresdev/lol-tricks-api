import 'dotenv/config'
import { riotFetch, ApiError } from '../src/services/riot-client.js'

async function main(): Promise<void> {
  try {
    const res = await riotFetch<{ tier: string; entries: unknown[] }>(
      'euw1.api.riotgames.com',
      '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5',
    )
    console.log(`OK — ${res.tier} league with ${res.entries.length} entries`)
    process.exit(0)
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`FAILED — ${e.statusCode} ${e.message}`)
    } else {
      console.error(`FAILED — ${String(e)}`)
    }
    process.exit(1)
  }
}

void main()
