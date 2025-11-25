import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Get the API URL for the backend server.
 *
 * Resolution order:
 * 1. EXPO_PUBLIC_API_URL from process.env (inlined at build time by Expo)
 * 2. EXPO_PUBLIC_API_URL from Constants.expoConfig.extra (dev client fallback)
 * 3. Platform-specific fallbacks (localhost for web/iOS, warning for Android)
 */
export function getApiUrl(): string {
  // EXPO_PUBLIC_ vars are inlined at build time by Expo's babel plugin
  // Check this FIRST since it's the most reliable for production builds
  const envApiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envApiUrl) {
    return envApiUrl;
  }

  // Fallback to Constants.expoConfig for development client
  const configApiUrl = Constants.expoConfig?.extra?.EXPO_PUBLIC_API_URL;
  if (configApiUrl) {
    return configApiUrl;
  }

  // Platform-specific fallbacks
  if (Platform.OS === 'web' || Platform.OS === 'ios') {
    // iOS simulator and web can access localhost directly
    return 'http://localhost:3000';
  }

  // Android emulator/device cannot access localhost on the host machine
  // User needs to run "npm run set-local-ip" or manually set EXPO_PUBLIC_API_URL
  console.warn(
    '[api] EXPO_PUBLIC_API_URL not set. Android cannot use localhost.\n' +
    'Run "npm run set-local-ip" or manually set EXPO_PUBLIC_API_URL in .env'
  );

  return 'http://localhost:3000';
}
