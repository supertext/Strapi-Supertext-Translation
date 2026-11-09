module.exports = ({ env }) => ({
  'users-permissions': {
    config: {
      jwtSecret: env('JWT_SECRET'),
    },
  },
  upload: {
    config: {
      provider: 'local',
    },
  },
  supertext: {
    enabled: true,
    config: {
      apiKey: env('SUPERTEXT_API_KEY'),
      endpoint: env('SUPERTEXT_API_ENDPOINT', 'https://api.supertext.com/v1/'),
      // The language mapping is chosen under Settings → Supertext → Translation (the demo seeds
      // formal address for the Swiss locales once, see src/index.js); `locales` here would override it.
    },
  },
});
