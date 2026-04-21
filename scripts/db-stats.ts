import 'dotenv/config'
import { prisma } from '../src/prisma.js'

async function main(): Promise<void> {
  const [
    totalPlayers,
    masterPlusPlayers,
    totalMatches,
    totalParticipants,
    recentMatches,
  ] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({
      where: { tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] } },
    }),
    prisma.match.count(),
    prisma.matchParticipant.count(),
    prisma.match.count({
      where: {
        gameCreation: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
      },
    }),
  ])

  const byRegion = await prisma.player.groupBy({
    by: ['region', 'tier'],
    _count: { _all: true },
    where: { tier: { in: ['MASTER', 'GRANDMASTER', 'CHALLENGER'] } },
    orderBy: [{ region: 'asc' }, { tier: 'asc' }],
  })

  console.log(`Players total: ${totalPlayers}`)
  console.log(`  Master+:     ${masterPlusPlayers}`)
  console.log(`Matches total: ${totalMatches}`)
  console.log(`  last 60d:    ${recentMatches}`)
  console.log(`Participants:  ${totalParticipants}`)
  console.log(`\nMaster+ by region/tier:`)
  for (const r of byRegion) {
    console.log(`  ${r.region.padEnd(6)} ${r.tier.padEnd(12)} ${r._count._all}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
