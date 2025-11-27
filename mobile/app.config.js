const baseConfig = require("./app.json");

module.exports = ({ config }) => {
  // Use env var if set, otherwise default to production URL
  const apiUrl =
    process.env.EXPO_PUBLIC_API_URL || "https://tap-story-api.onrender.com";

  const isDev = process.env.APP_VARIANT === "development";
  const androidPackage = isDev ? "com.tapstory.app.dev" : "com.tapstory.app";
  const iosBundleId = isDev ? "com.tapstory.app.dev" : "com.tapstory.app";

  return {
    ...baseConfig.expo,
    name: isDev ? "Tap Story (Dev)" : baseConfig.expo.name,
    android: {
      ...baseConfig.expo.android,
      ...config?.android,
      package: androidPackage,
    },
    ios: {
      ...baseConfig.expo.ios,
      ...config?.ios,
      bundleIdentifier: iosBundleId,
    },
    extra: {
      ...baseConfig.expo.extra,
      ...config?.extra,
      EXPO_PUBLIC_API_URL: apiUrl,
    },
  };
};
