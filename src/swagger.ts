const regionParam = {
  in: 'query',
  name: 'region',
  schema: { type: 'string', default: 'euw' },
  description: 'Server region (euw, na, kr, eune, br, jp, lan, las, oce, tr, ru)',
}

export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'LoL Tricks API',
    version: '1.0.0',
    description:
      'REST API for League of Legends player analytics — OTP detection, champion mains, match history, and league standings.',
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
        description: 'Returns top 50 players sorted by LP for a given ranked tier.',
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
                    players: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          summonerId: { type: 'string' },
                          puuid: { type: 'string' },
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
          'Analyzes top players\' recent matches to identify one-trick-ponies (35%+ games on one champion).',
        tags: ['OTP'],
        parameters: [
          regionParam,
          {
            in: 'query',
            name: 'tier',
            schema: { type: 'string', enum: ['challenger', 'grandmaster', 'master'], default: 'challenger' },
          },
          {
            in: 'query',
            name: 'limit',
            schema: { type: 'integer', default: 5, maximum: 10 },
            description: 'Number of top players to analyze',
          },
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
        summary: 'Find top players for a champion',
        description:
          'Searches Challenger/Grandmaster/Master for players with 50k+ mastery points on a specific champion.',
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
          'Fetches and stores data for top 10 players in a tier. Requires secret for authorization.',
        tags: ['Collect'],
        parameters: [
          regionParam,
          {
            in: 'query',
            name: 'tier',
            schema: { type: 'string', enum: ['challenger', 'grandmaster', 'master'], default: 'challenger' },
          },
          {
            in: 'query',
            name: 'secret',
            required: true,
            schema: { type: 'string' },
            description: 'Cron secret for authorization',
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
