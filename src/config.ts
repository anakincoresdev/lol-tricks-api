import dotenv from 'dotenv'

// `override: true` — .env wins over pre-existing shell env vars. Without
// this a stale `export RIOT_API_KEY=…` in the developer's zsh would keep
// shadowing the fresh value in .env during `npm run dev`. Safe on
// Vercel: there's no .env file there (gitignored), so `.config()` is a
// no-op and the platform-injected env vars pass through unchanged.
dotenv.config({ override: true })

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  riotApiKey: process.env['RIOT_API_KEY'] ?? '',
  cronSecret: process.env['CRON_SECRET'] ?? '',
  databaseUrl: process.env['DATABASE_URL'] ?? '',
}
