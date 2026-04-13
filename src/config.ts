import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  riotApiKey: process.env['RIOT_API_KEY'] ?? '',
  cronSecret: process.env['CRON_SECRET'] ?? '',
  databaseUrl: process.env['DATABASE_URL'] ?? '',
}
