import 'dotenv/config'
import { prisma } from '../src/prisma.js'

async function main(): Promise<void> {
  const rows = await prisma.matchParticipant.groupBy({
    by: ['championName'],
    where: {
      match: {
        gameCreation: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
        queueId: 420,
      },
    },
    _count: { _all: true },
    orderBy: { _count: { championName: 'desc' } },
    take: 20,
  })

  console.log('Top champions by games in last 60d:')
  for (const r of rows) {
    console.log(`  ${r.championName.padEnd(18)} ${r._count._all}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
