// Quick status / coverage report. Run any time to see how close we are
// to "top-100 on every champion".
//
//   node ops/status.cjs            # full report
//   node ops/status.cjs --champion=Ahri  # details for one champion

const { prisma, loadChampions } = require('./shared.cjs')

function parseArgs() {
  const out = { champion: null, thresholds: 'strict,relaxed,open', json: false }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') {
      out.json = true
      continue
    }
    const [k, v] = arg.replace(/^--/, '').split('=', 2)
    if (k === 'champion') out.champion = v
  }
  return out
}

async function main() {
  const cfg = parseArgs()

  const [
    totalPlayers,
    masterPlus,
    totalMatches,
    recentMatches,
    totalParticipants,
  ] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({
      where: { tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] } },
    }),
    prisma.match.count(),
    prisma.match.count({
      where: {
        gameCreation: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
        queueId: 420,
      },
    }),
    prisma.matchParticipant.count(),
  ])

  const byRegionTier = await prisma.player.groupBy({
    by: ['region', 'tier'],
    _count: { _all: true },
    where: { tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] } },
    orderBy: [{ region: 'asc' }, { tier: 'asc' }],
  })

  if (!cfg.json) {
    console.log('===== DB summary =====')
    console.log(`Players total:       ${totalPlayers}`)
    console.log(`  Master+:           ${masterPlus}`)
    console.log(`Matches total:       ${totalMatches}`)
    console.log(`  ranked solo, 60d:  ${recentMatches}`)
    console.log(`Participants:        ${totalParticipants}`)
    console.log('\nMaster+ by region/tier:')
    for (const r of byRegionTier) {
      console.log(`  ${r.region.padEnd(6)} ${r.tier.padEnd(12)} ${r._count._all}`)
    }
  }

  const champions = await loadChampions()
  const allChampionNames = champions.all.sort()

  if (cfg.champion) {
    const rows = await countForChampion(cfg.champion)
    if (cfg.json) {
      console.log(JSON.stringify({ champion: cfg.champion, ...rows }, null, 2))
    } else {
      console.log(`\n===== ${cfg.champion} =====`)
      console.log(`strict  (>=30 games, >=20% share, WR>50%):  ${rows.strict}`)
      console.log(`relaxed (>=10 games, >=10% share, WR>50%):  ${rows.relaxed}`)
      console.log(`open    (>=5 games, any share, any WR):     ${rows.open}`)
    }
    return
  }

  // Full coverage report
  if (!cfg.json) {
    console.log(`\n===== Coverage across ${allChampionNames.length} champions =====`)
  }
  const buckets = {
    strict100: 0,
    strict50: 0,
    strict10: 0,
    strict0: 0,
    relaxed100: 0,
    open100: 0,
    coveredAtAll: 0,
  }
  const perChampion = []

  let i = 0
  for (const champ of allChampionNames) {
    i++
    const rows = await countForChampion(champ)
    perChampion.push({ champion: champ, ...rows })
    if (rows.strict >= 100) buckets.strict100++
    else if (rows.strict >= 50) buckets.strict50++
    else if (rows.strict >= 10) buckets.strict10++
    else buckets.strict0++
    if (rows.relaxed >= 100) buckets.relaxed100++
    if (rows.open >= 100) buckets.open100++
    if (rows.open > 0) buckets.coveredAtAll++

    if (!cfg.json && i % 25 === 0) {
      process.stdout.write(`  …${i}/${allChampionNames.length} scanned\r`)
    }
  }

  if (cfg.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary: {
            totalPlayers,
            masterPlus,
            totalMatches,
            recentMatches,
            totalParticipants,
            byRegionTier,
          },
          buckets,
          perChampion,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`\n  strict ≥100:              ${buckets.strict100}`)
  console.log(`  strict 50-99:             ${buckets.strict50}`)
  console.log(`  strict 10-49:             ${buckets.strict10}`)
  console.log(`  strict <10:               ${buckets.strict0}`)
  console.log(`  relaxed ≥100:             ${buckets.relaxed100}`)
  console.log(`  open ≥100:                ${buckets.open100}`)
  console.log(`  covered at all (open>0):  ${buckets.coveredAtAll}`)

  const missing = perChampion.filter((p) => p.open === 0).map((p) => p.champion)
  const short = perChampion
    .filter((p) => p.open > 0 && p.open < 100)
    .map(({ champion, open }) => ({ champ: champion, n: open }))
  if (missing.length) {
    console.log(`\nMissing (${missing.length}): ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? '…' : ''}`)
  }
  short.sort((a, b) => a.n - b.n)
  if (short.length) {
    console.log(`\nShort (<100) sorted worst first, top 20:`)
    for (const { champ, n } of short.slice(0, 20)) {
      console.log(`  ${champ.padEnd(18)} ${n}`)
    }
  }
}

async function countForChampion(champion) {
  const [strictRows, relaxedRows, openRows] = await Promise.all([
    prisma.$queryRaw`
      WITH w AS (
        SELECT mp.puuid, m.region,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS cg,
          COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.win)::bigint AS cw
        FROM "MatchParticipant" mp
        INNER JOIN "Match" m ON m.id = mp."matchId"
        WHERE m."gameCreation" >= NOW() - INTERVAL '60 days' AND m."queueId" = 420
        GROUP BY mp.puuid, m.region
      )
      SELECT COUNT(*)::int AS n FROM "Player" p INNER JOIN w ON w.puuid=p.puuid AND w.region=p.region
      WHERE p.tier IN ('MASTER','GRANDMASTER','CHALLENGER')
        AND w.total >= 30
        AND w.cg::float >= 0.20 * w.total::float
        AND w.cw::float / NULLIF(w.cg,0)::float > 0.5
    `,
    prisma.$queryRaw`
      WITH w AS (
        SELECT mp.puuid, m.region,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS cg,
          COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.win)::bigint AS cw
        FROM "MatchParticipant" mp
        INNER JOIN "Match" m ON m.id = mp."matchId"
        WHERE m."gameCreation" >= NOW() - INTERVAL '60 days' AND m."queueId" = 420
        GROUP BY mp.puuid, m.region
      )
      SELECT COUNT(*)::int AS n FROM "Player" p INNER JOIN w ON w.puuid=p.puuid AND w.region=p.region
      WHERE p.tier IN ('MASTER','GRANDMASTER','CHALLENGER')
        AND w.total >= 10
        AND w.cg::float >= 0.10 * w.total::float
        AND w.cw::float / NULLIF(w.cg,0)::float > 0.5
    `,
    prisma.$queryRaw`
      WITH w AS (
        SELECT mp.puuid, m.region,
          COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS cg
        FROM "MatchParticipant" mp
        INNER JOIN "Match" m ON m.id = mp."matchId"
        WHERE m."gameCreation" >= NOW() - INTERVAL '60 days' AND m."queueId" = 420
        GROUP BY mp.puuid, m.region
      )
      SELECT COUNT(*)::int AS n FROM "Player" p INNER JOIN w ON w.puuid=p.puuid AND w.region=p.region
      WHERE p.tier IN ('MASTER','GRANDMASTER','CHALLENGER')
        AND w.cg >= 5
    `,
  ])
  return {
    strict: Number(strictRows[0].n),
    relaxed: Number(relaxedRows[0].n),
    open: Number(openRows[0].n),
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
