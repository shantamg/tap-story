const baseConfig = require('./app.json');

module.exports = ({ config }) => {
  // Set default API URL for production if not provided via environment
  if (!process.env.EXPO_PUBLIC_API_URL) {
    // TODO: Update this to your production API URL when deployed
    process.env.EXPO_PUBLIC_API_URL = 'https://api.tapstory.app';
  }

  return {
    ...baseConfig.expo,
    ...config,
    extra: {
      ...baseConfig.expo.extra,
      ...config?.extra,
      EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    },
  };
};
