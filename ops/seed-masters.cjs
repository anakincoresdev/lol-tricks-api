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
    // Master tier can have 10k+ entries per region — most of them are
    // not OTP candidates and ingesting them all just burns rate-limit
    // budget on `deep-backfill` afterwards. Top-2000 by LP still covers
    // everyone who's serious about climbing out of Master, and the
    // /global WHERE clause filters the rest. Override with
    // --master-cap=N on the CLI, or pass --master-cap=0 for no cap.
    masterCap: 2000,
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

  // Sort master tier by LP so --master-cap trims from the top. With cap
  // disabled (0) the order doesn't matter for correctness, just for
  // progress reporting: we seed highest-LP players first.
  let entries = league.entries.slice().sort((a, b) => b.leaguePoints - a.leaguePoints)
  if (tier === 'master' && masterCap > 0 && entries.length > masterCap) {
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
  let iconFetched = 0
  let iconFailed = 0
  const iconFailSamples = []
  for (const entry of entries) {
    resolved++
    // Check what we already have — avoid redundant Riot calls when the
    // row is already complete.
    const existing = await prisma.player.findUnique({
      where: { puuid_region: { puuid: entry.puuid, region } },
      select: { gameName: true, profileIconId: true },
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

    // profileIconId comes from summoner-v4 on the PLATFORM host. A
    // failure here leaves the existing value (or null on first seed)
    // so the avatar column silently falls back. We log failures with
    // sample puuids so you can see _why_ some stay null (expired key,
    // region mismatch, account deleted, etc.).
    let profileIconId = existing?.profileIconId ?? null
    if (profileIconId == null) {
      try {
        const summoner = await riotFetch(
          platformHost,
          `/lol/summoner/v4/summoners/by-puuid/${entry.puuid}`,
        )
        if (typeof summoner.profileIconId === 'number') {
          profileIconId = summoner.profileIconId
          iconFetched++
        } else {
          iconFailed++
          if (iconFailSamples.length < 3) {
            iconFailSamples.push({
              puuid: entry.puuid,
              reason: 'no-profile-icon-id',
            })
          }
        }
      } catch (e) {
        iconFailed++
        if (iconFailSamples.length < 3) {
          iconFailSamples.push({
            puuid: entry.puuid,
            status: e.status,
            message: e.message,
          })
        }
      }
    }

    // Defensive coercion — Riot occasionally returns fields as strings
    // or omits them entirely on edge-case rows. Prisma is strict about
    // types and will reject a whole row for a single null/undefined int.
    const wins = Number(entry.wins) || 0
    const losses = Number(entry.losses) || 0
    const lp = Number(entry.leaguePoints) || 0
    const total = wins + losses
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0
    const tierValue =
      typeof league.tier === 'string' && league.tier
        ? league.tier
        : tier.toUpperCase()
    const rankValue =
      typeof entry.rank === 'string' && entry.rank ? entry.rank : 'I'

    try {
      await prisma.player.upsert({
        where: { puuid_region: { puuid: entry.puuid, region } },
        update: {
          gameName,
          tier: tierValue,
          rank: rankValue,
          lp,
          wins,
          losses,
          winRate,
          hotStreak: !!entry.hotStreak,
          profileIconId,
        },
        create: {
          puuid: entry.puuid,
          gameName,
          region,
          tier: tierValue,
          rank: rankValue,
          lp,
          wins,
          losses,
          winRate,
          hotStreak: !!entry.hotStreak,
          totalGames: 0,
          profileIconId,
        },
      })
      upserted++
    } catch (e) {
      // Don't kill the whole region on one bad row — log the offending
      // entry + the Prisma detail so we can see the real cause, then
      // move on. The detail line after "Invalid prisma.player.upsert()
      // invocation" is what tells us what Prisma actually rejected.
      console.error(
        `[${region}/${tier}] upsert failed for ${entry.puuid} — ${e.message}`,
      )
      console.error(
        `  entry: ${JSON.stringify({
          puuid: entry.puuid,
          gameName,
          tier: tierValue,
          rank: rankValue,
          lp,
          wins,
          losses,
          winRate,
          hotStreak: !!entry.hotStreak,
          profileIconId,
        })}`,
      )
    }

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
    `[${region}/${tier}] done: upserted=${upserted}, droppedOut=${dropped.length}, iconFetched=${iconFetched}, iconFailed=${iconFailed}`,
  )
  if (iconFailSamples.length > 0) {
    console.log(
      `[${region}/${tier}] icon-fail samples: ${JSON.stringify(iconFailSamples)}`,
    )
  }
  logLine('seed-masters', {
    region,
    tier,
    upserted,
    droppedOut: dropped.length,
    iconFetched,
    iconFailed,
    iconFailSamples,
  })
}

async function main() {
  const cfg = parseArgs()
  const start = Date.now()
  console.log(
    `[seed-masters] regions=${cfg.regions.join(',')} tiers=${cfg.tiers.join(',')} master-cap=${cfg.masterCap > 0 ? cfg.masterCap : 'none'}`,
  )

  let abort = false
  for (const region of cfg.regions) {
    if (abort) break
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
        // 401/403 = key invalid or expired — no point in moving to the
        // next region/tier, everything will keep failing identically.
        if (e.status === 401 || e.status === 403) {
          console.error('API key dead — aborting.')
          abort = true
          break
        }
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
