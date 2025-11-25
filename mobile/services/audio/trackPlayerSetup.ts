/**
 * TrackPlayerService - Setup and configuration for react-native-track-player
 *
 * IMPORTANT: This file configures the audio session for simultaneous playback
 * and recording (PlayAndRecord mode). This is critical for the duet feature.
 */
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
  IOSCategoryOptions,
  RepeatMode,
} from 'react-native-track-player';
import { Platform } from 'react-native';

// Configurable latency offset for recording sync (in milliseconds)
// Adjust this value based on device testing - typical values: 150-350ms
export const LATENCY_OFFSET_MS = 250;

let isSetup = false;

/**
 * Initialize Track Player with proper audio session configuration.
 *
 * Audio Session Configuration (iOS):
 * - Category: PlayAndRecord - Allows simultaneous playback and recording
 * - Mode: Default - Standard audio mode
 * - Options:
 *   - DefaultToSpeaker - Routes audio to speaker instead of earpiece
 *   - AllowBluetooth - Enables Bluetooth headset support
 *   - MixWithOthers - Allows mixing with other audio apps
 */
export async function setupTrackPlayer(): Promise<void> {
  if (isSetup) {
    console.log('[TrackPlayer] Already setup, skipping');
    return;
  }

  try {
    console.log('[TrackPlayer] Setting up Track Player...');

    // Setup the player with audio session configuration
    await TrackPlayer.setupPlayer({
      // iOS Audio Session Configuration - CRITICAL for duet recording
      iosCategory: IOSCategory.PlayAndRecord,
      iosCategoryMode: IOSCategoryMode.Default,
      iosCategoryOptions: [
        IOSCategoryOptions.DefaultToSpeaker,
        IOSCategoryOptions.AllowBluetooth,
        IOSCategoryOptions.AllowBluetoothA2DP,
        IOSCategoryOptions.MixWithOthers,
      ],
      // Buffer configuration for lower latency
      // Smaller buffer = lower latency but may cause audio glitches
      // Larger buffer = higher latency but smoother playback
      minBuffer: 15, // seconds
      maxBuffer: 50, // seconds
      playBuffer: 2.5, // seconds of buffer before playback starts
      backBuffer: 0, // seconds to keep in buffer behind playhead
    });

    // Update player options
    await TrackPlayer.updateOptions({
      // Android: Continue playback even if app is killed
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
      },
      // Capabilities shown in notification/lock screen
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
      ],
      // Compact notification capabilities
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
      ],
      // Disable notification for duet mode (we handle UI ourselves)
      notificationCapabilities: [],
    });

    // Set repeat mode to off by default
    await TrackPlayer.setRepeatMode(RepeatMode.Off);

    isSetup = true;
    console.log('[TrackPlayer] Setup complete');
  } catch (error) {
    console.error('[TrackPlayer] Setup failed:', error);
    throw error;
  }
}

/**
 * Destroy the track player instance.
 * Call this when the app is being terminated or the feature is no longer needed.
 */
export async function destroyTrackPlayer(): Promise<void> {
  if (!isSetup) return;

  try {
    await TrackPlayer.destroy();
    isSetup = false;
    console.log('[TrackPlayer] Destroyed');
  } catch (error) {
    console.error('[TrackPlayer] Destroy failed:', error);
  }
}

/**
 * Check if Track Player is setup and ready.
 */
export function isTrackPlayerSetup(): boolean {
  return isSetup;
}

/**
 * Reset the setup flag (useful for error recovery).
 */
export function resetTrackPlayerSetup(): void {
  isSetup = false;
}

