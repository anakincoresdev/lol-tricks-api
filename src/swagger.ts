import swaggerJsdoc from 'swagger-jsdoc'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'LoL Tricks API',
      version: '1.0.0',
      description: 'REST API for League of Legends player analytics — OTP detection, champion mains, match history, and league standings.',
    },
    servers: [
      { url: 'https://lol-tricks-api.vercel.app', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local' },
    ],
  },
  apis: ['./src/routes/*.ts'],
}

export const swaggerSpec = swaggerJsdoc(options)
