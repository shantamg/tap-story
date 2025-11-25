/**
 * Custom Expo Config Plugin for react-native-track-player
 *
 * This plugin configures the native projects for audio playback:
 * - iOS: Adds audio background mode and required capabilities
 * - Android: Adds necessary permissions and service declarations
 */
const {
  withInfoPlist,
  withAndroidManifest,
  createRunOncePlugin,
} = require('@expo/config-plugins');

const pkg = require('react-native-track-player/package.json');

/**
 * Configure iOS Info.plist for audio playback
 */
function withTrackPlayerIOS(config) {
  return withInfoPlist(config, (config) => {
    // Ensure UIBackgroundModes includes 'audio'
    const backgroundModes = config.modResults.UIBackgroundModes || [];
    if (!backgroundModes.includes('audio')) {
      backgroundModes.push('audio');
    }
    config.modResults.UIBackgroundModes = backgroundModes;

    return config;
  });
}

/**
 * Configure Android Manifest for audio playback
 */
function withTrackPlayerAndroid(config) {
  return withAndroidManifest(config, (config) => {
    // Ensure tools namespace exists
    if (!config.modResults.manifest.$['xmlns:tools']) {
      config.modResults.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const mainApplication = config.modResults.manifest.application?.[0];

    if (mainApplication) {
      // Ensure services array exists
      if (!mainApplication.service) {
        mainApplication.service = [];
      }

      // Check if TrackPlayer service is already declared
      const trackPlayerServiceIndex = mainApplication.service.findIndex(
        (service) =>
          service.$?.['android:name'] === 'com.doublesymmetry.trackplayer.service.MusicService'
      );

      if (trackPlayerServiceIndex !== -1) {
        // If it exists, update it to have the replace attribute
         mainApplication.service[trackPlayerServiceIndex].$['tools:replace'] = 'android:exported';
         mainApplication.service[trackPlayerServiceIndex].$['android:exported'] = 'false';
      } else {
        // Add TrackPlayer service if not present
        mainApplication.service.push({
          $: {
            'android:name': 'com.doublesymmetry.trackplayer.service.MusicService',
            'android:exported': 'false',
            'tools:replace': 'android:exported',
          },
          'intent-filter': [
            {
              action: [
                {
                  $: {
                    'android:name': 'android.media.browse.MediaBrowserService',
                  },
                },
              ],
            },
          ],
        });
      }
    }

    // Ensure permissions are set
    const permissions = config.modResults.manifest['uses-permission'] || [];
    const requiredPermissions = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'android.permission.WAKE_LOCK',
    ];

    for (const permission of requiredPermissions) {
      const hasPermission = permissions.some(
        (p) => p.$?.['android:name'] === permission
      );
      if (!hasPermission) {
        permissions.push({
          $: { 'android:name': permission },
        });
      }
    }
    config.modResults.manifest['uses-permission'] = permissions;

    return config;
  });
}

/**
 * Main plugin function
 */
function withTrackPlayer(config) {
  config = withTrackPlayerIOS(config);
  config = withTrackPlayerAndroid(config);
  return config;
}

module.exports = createRunOncePlugin(withTrackPlayer, pkg.name, pkg.version);

