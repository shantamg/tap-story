const baseConfig = require("./app.json");

module.exports = ({ config }) => {
  // Set default API URL for production if not provided via environment
  if (!process.env.EXPO_PUBLIC_API_URL) {
    process.env.EXPO_PUBLIC_API_URL = "https://tap-story-api.onrender.com";
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
