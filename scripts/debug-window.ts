import 'dotenv/config'
import { prisma } from '../src/prisma.js'

interface Row {
  puuid: string
  gameName: string
  region: string
  tier: string
  lp: number
  totalGames: bigint
  championGames: bigint
  championWins: bigint
}

async function main(): Promise<void> {
  const champion = process.argv[2] ?? 'Diana'
  const rows = await prisma.$queryRaw<Row[]>`
    WITH window_stats AS (
      SELECT
        mp.puuid,
        m.region,
        COUNT(*)::bigint AS "totalGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion})::bigint AS "championGames",
        COUNT(*) FILTER (WHERE mp."championName" = ${champion} AND mp.win)::bigint AS "championWins"
      FROM "MatchParticipant" mp
      INNER JOIN "Match" m ON m.id = mp."matchId"
      WHERE m."gameCreation" >= NOW() - INTERVAL '60 days'
        AND m."queueId" = 420
      GROUP BY mp.puuid, m.region
    )
    SELECT
      p.puuid, p."gameName", p.region, p.tier, p.lp,
      ws."totalGames", ws."championGames", ws."championWins"
    FROM "Player" p
    INNER JOIN window_stats ws ON ws.puuid = p.puuid AND ws.region = p.region
    WHERE p.tier IN ('MASTER', 'GRANDMASTER', 'CHALLENGER')
    ORDER BY ws."championGames" DESC, p.lp DESC
    LIMIT 30
  `

  console.log(`Top 30 Master+ tracked players by ${champion} games (no filters):`)
  console.log('name'.padEnd(28), 'region', 'tier'.padEnd(12), 'LP', 'total', 'champ', 'wins', 'share', 'WR')
  for (const r of rows) {
    const total = Number(r.totalGames)
    const cg = Number(r.championGames)
    const cw = Number(r.championWins)
    const share = total > 0 ? Math.round((cg / total) * 100) : 0
    const wr = cg > 0 ? Math.round((cw / cg) * 100) : 0
    console.log(
      r.gameName.padEnd(28),
      r.region.padEnd(6),
      r.tier.padEnd(12),
      String(r.lp).padEnd(5),
      String(total).padEnd(5),
      String(cg).padEnd(5),
      String(cw).padEnd(4),
      `${share}%`.padEnd(5),
      `${wr}%`,
    )
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
