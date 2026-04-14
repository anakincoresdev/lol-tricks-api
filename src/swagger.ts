const regionParam = {
  in: 'query',
  name: 'region',
  schema: { type: 'string', default: 'euw' },
  description: 'Server region (euw, na, kr, eune, br, jp, lan, las, oce, tr, ru)',
}

const refreshParam = {
  in: 'query',
  name: 'refresh',
  schema: { type: 'string', enum: ['true'] },
  description: 'Set to "true" to bypass DB cache and fetch fresh data from Riot API',
}

export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'LoL Tricks API',
    version: '2.0.0',
    description:
      'REST API for League of Legends player analytics — OTP detection, champion mains, match history, and league standings. Data is cached in PostgreSQL; use /collect to populate, other endpoints read from cache with Riot API fallback.',
  },
  servers: [
    { url: 'https://lol-tricks-api.vercel.app', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  tags: [
    { name: 'League', description: 'Ranked league standings' },
    { name: 'OTP', description: 'One-trick-pony detection' },
    { name: 'Champions', description: 'Champion player search' },
    { name: 'Matches', description: 'Match history' },
    { name: 'Collect', description: 'Data collection (cron)' },
  ],
  paths: {
    '/api/riot/league/{tier}': {
      get: {
        summary: 'Get top players by tier',
        description:
          'Returns top 50 players sorted by LP. Reads from DB cache (10 min TTL), falls back to Riot API.',
        tags: ['League'],
        parameters: [
          {
            in: 'path',
            name: 'tier',
            required: true,
            schema: { type: 'string', enum: ['challenger', 'grandmaster', 'master'] },
            description: 'Ranked tier',
          },
          regionParam,
          refreshParam,
        ],
        responses: {
          '200': {
            description: 'List of top players',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tier: { type: 'string', example: 'CHALLENGER' },
                    region: { type: 'string', example: 'euw' },
                    source: { type: 'string', enum: ['cache', 'riot'] },
                    players: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          puuid: { type: 'string' },
                          gameName: { type: 'string' },
                          tier: { type: 'string' },
                          rank: { type: 'string' },
                          lp: { type: 'integer', example: 1500 },
                          wins: { type: 'integer' },
                          losses: { type: 'integer' },
                          winRate: { type: 'integer', example: 58 },
                          hotStreak: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid tier' },
        },
      },
    },

    '/api/riot/otp': {
      get: {
        summary: 'Find one-trick players',
        description:
          'Identifies OTP players (35%+ games on one champion). Reads from DB if collect has run, otherwise queries Riot API live.',
        tags: ['OTP'],
        parameters: [
          regionParam,
          {
            in: 'query',
            name: 'tier',
            schema: {
              type: 'string',
              enum: ['challenger', 'grandmaster', 'master'],
              default: 'challenger',
            },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', default: 20, maximum: 50 },
            description: 'Number of players to return',
          },
          refreshParam,
        ],
        responses: {
          '200': {
            description: 'List of OTP players',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    region: { type: 'string' },
                    tier: { type: 'string' },
                    otpThreshold: { type: 'integer', example: 35 },
                    source: { type: 'string', enum: ['cache', 'riot'] },
                    players: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          puuid: { type: 'string' },
                          gameName: { type: 'string', example: 'Player#EUW' },
                          tier: { type: 'string' },
                          lp: { type: 'integer' },
                          wins: { type: 'integer' },
                          losses: { type: 'integer' },
                          winRate: { type: 'integer' },
                          mainChampion: { type: 'string', example: 'Yasuo' },
                          mainChampionGames: { type: 'integer' },
                          totalGames: { type: 'integer' },
                          otpPercent: { type: 'integer', example: 67 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/riot/champion-players': {
      get: {
        summary: 'Find top players for a champion (single region)',
        description:
          'Searches for players with 50k+ mastery on a champion in one region. Reads from DB cache (30 min TTL), falls back to Riot API.',
        tags: ['Champions'],
        parameters: [
          {
            in: 'query',
            name: 'champion',
            required: true,
            schema: { type: 'string' },
            description: 'Champion name (e.g. Yasuo, LeeSin)',
          },
          regionParam,
          refreshParam,
        ],
        responses: {
          '200': {
            description: 'List of champion mains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    champion: { type: 'string' },
                    region: { type: 'string' },
                    source: { type: 'string', enum: ['cache', 'riot'] },
                    players: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          puuid: { type: 'string' },
                          gameName: { type: 'string', example: 'Player#EUW' },
                          region: { type: 'string' },
                          tier: { type: 'string' },
                          lp: { type: 'integer' },
                          wins: { type: 'integer' },
                          losses: { type: 'integer' },
                          winRate: { type: 'integer' },
                          masteryPoints: { type: 'integer', example: 500000 },
                          masteryLevel: { type: 'integer', example: 7 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Missing or unknown champion' },
        },
      },
    },

    '/api/riot/champion-players/multi': {
      get: {
        summary: 'Find top players for a champion across multiple regions',
        description:
          'Same as /champion-players but queries multiple regions in parallel. Returns results grouped by region and a merged allPlayers array sorted by LP.',
        tags: ['Champions'],
        parameters: [
          {
            in: 'query',
            name: 'champion',
            required: true,
            schema: { type: 'string' },
            description: 'Champion name (e.g. Yasuo, LeeSin)',
          },
          {
            in: 'query',
            name: 'regions',
            required: true,
            schema: { type: 'string' },
            description: 'Comma-separated regions (e.g. euw,na,kr). Max 11.',
          },
          refreshParam,
        ],
        responses: {
          '200': {
            description: 'Multi-region champion mains',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    champion: { type: 'string' },
                    regions: { type: 'array', items: { type: 'string' } },
                    byRegion: {
                      type: 'object',
                      description: 'Results keyed by region',
                      additionalProperties: {
                        type: 'object',
                        properties: {
                          source: { type: 'string', enum: ['cache', 'riot'] },
                          players: { type: 'array', items: { type: 'object' } },
                        },
                      },
                    },
                    allPlayers: {
                      type: 'array',
                      description: 'All players from all regions merged and sorted by LP',
                      items: {
                        type: 'object',
                        properties: {
                          puuid: { type: 'string' },
                          gameName: { type: 'string' },
                          region: { type: 'string' },
                          tier: { type: 'string' },
                          lp: { type: 'integer' },
                          wins: { type: 'integer' },
                          losses: { type: 'integer' },
                          winRate: { type: 'integer' },
                          masteryPoints: { type: 'integer' },
                          masteryLevel: { type: 'integer' },
                        },
                      },
                    },
                    errors: {
                      type: 'object',
                      description: 'Errors per region (only present if any region failed)',
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Missing champion or regions' },
        },
      },
    },

    '/api/riot/matches/{puuid}': {
      get: {
        summary: 'Get player match history',
        description: 'Returns recent ranked match IDs and detailed data for the first 5 matches.',
        tags: ['Matches'],
        parameters: [
          {
            in: 'path',
            name: 'puuid',
            required: true,
            schema: { type: 'string' },
            description: 'Player PUUID',
          },
          regionParam,
          {
            in: 'query',
            name: 'count',
            schema: { type: 'integer', default: 20, maximum: 100 },
            description: 'Number of match IDs to fetch',
          },
        ],
        responses: {
          '200': {
            description: 'Match history',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    puuid: { type: 'string' },
                    region: { type: 'string' },
                    matchIds: { type: 'array', items: { type: 'string' } },
                    matches: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          matchId: { type: 'string' },
                          champion: { type: 'string' },
                          win: { type: 'boolean' },
                          kills: { type: 'integer' },
                          deaths: { type: 'integer' },
                          assists: { type: 'integer' },
                          items: { type: 'array', items: { type: 'integer' } },
                          runes: { type: 'array', items: { type: 'object' } },
                          position: { type: 'string' },
                          cs: { type: 'integer' },
                          gameDuration: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Missing puuid' },
        },
      },
    },

    '/api/riot/player-champion-matches': {
      get: {
        summary: "Get player's matches on a specific champion",
        description:
          'Fetches up to 8 recent ranked matches where the player played a specific champion, with full build data.',
        tags: ['Matches'],
        parameters: [
          {
            in: 'query',
            name: 'puuid',
            required: true,
            schema: { type: 'string' },
            description: 'Player PUUID',
          },
          {
            in: 'query',
            name: 'champion',
            required: true,
            schema: { type: 'string' },
            description: 'Champion name (e.g. Yasuo)',
          },
          regionParam,
        ],
        responses: {
          '200': {
            description: 'Champion-specific match history with mastery info',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    puuid: { type: 'string' },
                    champion: { type: 'string' },
                    region: { type: 'string' },
                    gameName: { type: 'string' },
                    masteryPoints: { type: 'integer' },
                    masteryLevel: { type: 'integer' },
                    matches: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          matchId: { type: 'string' },
                          win: { type: 'boolean' },
                          kills: { type: 'integer' },
                          deaths: { type: 'integer' },
                          assists: { type: 'integer' },
                          items: { type: 'array', items: { type: 'integer' } },
                          runes: { type: 'array', items: { type: 'object' } },
                          summoner1Id: { type: 'integer' },
                          summoner2Id: { type: 'integer' },
                          cs: { type: 'integer' },
                          gameDuration: { type: 'integer' },
                          gameCreation: { type: 'integer' },
                          position: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Missing puuid or champion' },
        },
      },
    },

    '/api/riot/collect': {
      get: {
        summary: 'Collect player data (cron job)',
        description:
          'Main data pipeline. Fetches league standings, account names, top-5 champion mastery, and recent match data. Stores everything in PostgreSQL. Run via cron or manually with secret=manual.',
        tags: ['Collect'],
        parameters: [
          regionParam,
          {
            in: 'query',
            name: 'tier',
            schema: {
              type: 'string',
              enum: ['challenger', 'grandmaster', 'master'],
              default: 'challenger',
            },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', default: 50, maximum: 200 },
            description: 'Number of top players to collect',
          },
          {
            in: 'query',
            name: 'secret',
            required: true,
            schema: { type: 'string' },
            description: 'Cron secret for authorization (use "manual" for dev)',
          },
        ],
        responses: {
          '200': {
            description: 'Collection results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    region: { type: 'string' },
                    tier: { type: 'string' },
                    collected: { type: 'integer' },
                    total: { type: 'integer' },
                    newMatches: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { description: 'Unauthorized' },
        },
      },
    },

    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Server is running',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {},
}
