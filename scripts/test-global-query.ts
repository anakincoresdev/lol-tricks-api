import 'dotenv/config'
import { prisma } from '../src/prisma.js'

interface Row {
  puuid: string
  gameName: string
  region: string
  tier: string
  rank: string
  lp: number
  totalGames: bigint
  championGames: bigint
  championWins: bigint
  roleTop: bigint
  roleJungle: bigint
  roleMid: bigint
  roleAdc: bigint
  roleSupport: bigint
}

async function main(): Promise<void> {
  const champion = process.argv[2] ?? 'Diana'
  const limit = Number(process.argv[3] ?? 100)

  console.log(`Querying top-${limit} players on ${champion}…\n`)

  const rows = await prisma.$queryRaw<Row[]>`
    WITH window_stats AS (
      SELECT
        mp.puuid,
        m.region,
        COUNT(*)::bigint AS "totalGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS "championGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.win)::bigint AS "championWins",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'TOP')::bigint AS "roleTop",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'JUNGLE')::bigint AS "roleJungle",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'MIDDLE')::bigint AS "roleMid",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'BOTTOM')::bigint AS "roleAdc",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.position = 'UTILITY')::bigint AS "roleSupport"
      FROM "MatchParticipant" mp
      INNER JOIN "Match" m ON m.id = mp."matchId"
      WHERE m."gameCreation" >= NOW() - INTERVAL '60 days'
        AND m."queueId" = 420
      GROUP BY mp.puuid, m.region
    )
    SELECT
      p.puuid, p."gameName", p.region, p.tier, p.rank, p.lp,
      ws."totalGames", ws."championGames", ws."championWins",
      ws."roleTop", ws."roleJungle", ws."roleMid", ws."roleAdc", ws."roleSupport"
    FROM "Player" p
    INNER JOIN window_stats ws ON ws.puuid = p.puuid AND ws.region = p.region
    WHERE p.tier IN ('MASTER', 'GRANDMASTER', 'CHALLENGER')
      AND ws."totalGames" >= 30
      AND ws."championGames"::float >= 0.20 * ws."totalGames"::float
      AND ws."championWins"::float / NULLIF(ws."championGames", 0)::float > 0.5
    ORDER BY p.lp DESC
    LIMIT ${limit}
  `

  console.log(`Matched ${rows.length} players.\n`)
  for (const r of rows) {
    const total = Number(r.totalGames)
    const cg = Number(r.championGames)
    const cw = Number(r.championWins)
    const share = Math.round((cg / total) * 100)
    const wr = Math.round((cw / cg) * 100)
    console.log(
      `  ${r.gameName.padEnd(28)} ${r.region.padEnd(4)} ${r.tier.padEnd(12)} LP=${String(r.lp).padEnd(5)} total=${total} ${champion}=${cg} (${share}%) WR=${wr}% roles=J${r.roleJungle}/M${r.roleMid}/T${r.roleTop}/A${r.roleAdc}/S${r.roleSupport}`,
    )
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
