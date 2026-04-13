import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { swaggerSpec } from './swagger.js'
import { errorHandler } from './middleware/error-handler.js'
import leagueRouter from './routes/league.js'
import otpRouter from './routes/otp.js'
import collectRouter from './routes/collect.js'
import championPlayersRouter from './routes/champion-players.js'
import matchesRouter from './routes/matches.js'
import playerChampionMatchesRouter from './routes/player-champion-matches.js'

const app = express()

app.use(cors())
app.use(express.json())

// Routes
app.use('/api/riot', leagueRouter)
app.use('/api/riot', otpRouter)
app.use('/api/riot', collectRouter)
app.use('/api/riot', championPlayersRouter)
app.use('/api/riot', matchesRouter)
app.use('/api/riot', playerChampionMatchesRouter)

// Swagger docs
app.get('/docs.json', (_req, res) => {
  res.json(swaggerSpec)
})
app.get('/docs', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>LoL Tricks API — Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/docs.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>`)
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Error handler
app.use(errorHandler)

// Local dev: listen on port. Vercel: export the app.
if (process.env['VERCEL'] !== '1') {
  app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`)
  })
}

export default app
