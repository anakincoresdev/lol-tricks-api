// Populate Player + ChampionMastery records for Master/GM/Challenger
// across EUW, NA, KR. This is what lets /champion-players/global even see
// candidates — if a puuid isn't in Player, the INNER JOIN drops it.
//
// Strategy:
//   for each (region, tier):
//     fetch the league list (single Riot call)
//     fetch account name (riot/account/v1) for each puuid — batched
//     upsert Player
//
// Mastery/match-ids come from deep-backfill.cjs. This script is small
// and fast (~20 minutes for 3 regions) and deliberately does only the
// minimum to unblock the SQL query.
//
// Usage:
//   node ops/seed-masters.cjs
//   node ops/seed-masters.cjs --regions=euw,na
//   node ops/seed-masters.cjs --tiers=challenger,grandmaster

const {
  prisma,
  riotFetch,
  getPlatformHost,
  getRegionalHost,
  logLine,
} = require('./shared.cjs')

const DEFAULT_REGIONS = ['euw', 'na', 'kr']
const DEFAULT_TIERS = ['challenger', 'grandmaster', 'master']

function parseArgs() {
  const out = {
    regions: DEFAULT_REGIONS,
    tiers: DEFAULT_TIERS,
    masterCap: 400, // cap master tier to top-400 by LP to keep scope sane
  }
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=', 2)
    if (k === 'regions' && v) out.regions = v.split(',')
    else if (k === 'tiers' && v) out.tiers = v.split(',')
    else if (k === 'master-cap' && v) out.masterCap = Number(v)
  }
  return out
}

async function seedTierForRegion(region, tier, masterCap) {
  const platformHost = getPlatformHost(region)
  const regionalHost = getRegionalHost(region)
  console.log(`[${region}/${tier}] fetching league…`)
  const league = await riotFetch(
    platformHost,
    `/lol/league/v4/${tier}leagues/by-queue/RANKED_SOLO_5x5`,
  )

  // For master tier, trim to top-N by LP (it can have thousands of entries).
  let entries = league.entries.slice().sort((a, b) => b.leaguePoints - a.leaguePoints)
  if (tier === 'master' && entries.length > masterCap) {
    entries = entries.slice(0, masterCap)
  }

  console.log(`[${region}/${tier}] ${entries.length} players (raw ${league.entries.length})`)
  logLine('seed-masters', {
    region,
    tier,
    raw: league.entries.length,
    kept: entries.length,
  })

  let resolved = 0
  let upserted = 0
  for (const entry of entries) {
    resolved++
    // Check if we already have this player's name — avoid hitting account-v1
    // if so (saves rate budget).
    const existing = await prisma.player.findUnique({
      where: { puuid_region: { puuid: entry.puuid, region } },
      select: { gameName: true },
    })

    let gameName = existing?.gameName
    if (!gameName || gameName === 'Unknown') {
      try {
        const account = await riotFetch(
          regionalHost,
          `/riot/account/v1/accounts/by-puuid/${entry.puuid}`,
        )
        gameName = `${account.gameName}#${account.tagLine}`
      } catch (e) {
        gameName = existing?.gameName || 'Unknown'
      }
    }

    const total = entry.wins + entry.losses
    const winRate = total > 0 ? Math.round((entry.wins / total) * 100) : 0

    await prisma.player.upsert({
      where: { puuid_region: { puuid: entry.puuid, region } },
      update: {
        gameName,
        tier: league.tier,
        rank: entry.rank ?? 'I',
        lp: entry.leaguePoints,
        wins: entry.wins,
        losses: entry.losses,
        winRate,
        hotStreak: !!entry.hotStreak,
      },
      create: {
        puuid: entry.puuid,
        gameName,
        region,
        tier: league.tier,
        rank: entry.rank ?? 'I',
        lp: entry.leaguePoints,
        wins: entry.wins,
        losses: entry.losses,
        winRate,
        hotStreak: !!entry.hotStreak,
        totalGames: 0,
      },
    })
    upserted++

    if (resolved % 50 === 0) {
      console.log(`[${region}/${tier}] ${resolved}/${entries.length}`)
    }
  }

  // Anyone who was Master+ in this region/tier before but dropped out — mark UNRANKED.
  const currentPuuids = new Set(entries.map((e) => e.puuid))
  const existing = await prisma.player.findMany({
    where: { region, tier: league.tier },
    select: { puuid: true },
  })
  const dropped = existing.filter((e) => !currentPuuids.has(e.puuid))
  for (const p of dropped) {
    await prisma.player.update({
      where: { puuid_region: { puuid: p.puuid, region } },
      data: { tier: 'UNRANKED' },
    })
  }

  console.log(
    `[${region}/${tier}] done: upserted=${upserted}, droppedOut=${dropped.length}`,
  )
  logLine('seed-masters', {
    region,
    tier,
    upserted,
    droppedOut: dropped.length,
  })
}

async function main() {
  const cfg = parseArgs()
  const start = Date.now()
  console.log(
    `[seed-masters] regions=${cfg.regions.join(',')} tiers=${cfg.tiers.join(',')} master-cap=${cfg.masterCap}`,
  )

  for (const region of cfg.regions) {
    for (const tier of cfg.tiers) {
      try {
        await seedTierForRegion(region, tier, cfg.masterCap)
      } catch (e) {
        console.error(`[${region}/${tier}] FAIL: ${e.status || ''} ${e.message}`)
        logLine('seed-masters', {
          region,
          tier,
          error: e.message,
          status: e.status,
        })
      }
    }
  }

  const totalMasterPlus = await prisma.player.count({
    where: { tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] } },
  })
  console.log(
    `[seed-masters] finished in ${((Date.now() - start) / 1000).toFixed(0)}s. Master+ players in DB: ${totalMasterPlus}`,
  )
  logLine('seed-masters', {
    event: 'done',
    durationSec: Math.round((Date.now() - start) / 1000),
    masterPlus: totalMasterPlus,
  })
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
