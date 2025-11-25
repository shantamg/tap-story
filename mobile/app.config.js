const baseConfig = require("./app.json");

module.exports = ({ config }) => {
  // Use env var if set, otherwise default to production URL
  const apiUrl =
    process.env.EXPO_PUBLIC_API_URL || "https://tap-story-api.onrender.com";

  return {
    ...baseConfig.expo,
    ...config,
    extra: {
      ...baseConfig.expo.extra,
      ...config?.extra,
      EXPO_PUBLIC_API_URL: apiUrl,
    },
  };
};
