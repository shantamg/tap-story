const baseConfig = require("./app.json");

module.exports = ({ config }) => {
  // Use env var if set, otherwise default to production URL
  const apiUrl =
    process.env.EXPO_PUBLIC_API_URL || "https://tap-story-api.onrender.com";

  const isDev = process.env.APP_VARIANT === "development";

  return {
    ...baseConfig.expo,
    ...config,
    name: isDev ? "Tap Story (Dev)" : baseConfig.expo.name,
    android: {
      ...baseConfig.expo.android,
      package: isDev ? "com.tapstory.app.dev" : baseConfig.expo.android.package,
    },
    ios: {
      ...baseConfig.expo.ios,
      bundleIdentifier: isDev
        ? "com.tapstory.app.dev"
        : baseConfig.expo.ios.bundleIdentifier,
    },
    extra: {
      ...baseConfig.expo.extra,
      ...config?.extra,
      EXPO_PUBLIC_API_URL: apiUrl,
    },
  };
};
