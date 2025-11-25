import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import TrackPlayer from 'react-native-track-player';
import { colors } from '../utils/theme';
import { playbackService, setupTrackPlayer } from '../services/audio';

// Register the playback service - this MUST be done at the top level
// It handles background audio events (play/pause from notification, bluetooth, etc.)
TrackPlayer.registerPlaybackService(() => playbackService);

export default function RootLayout() {
  // Initialize Track Player on app start
  useEffect(() => {
    let mounted = true;

    const initTrackPlayer = async () => {
      try {
        await setupTrackPlayer();
        console.log('[RootLayout] Track Player initialized');
      } catch (error) {
        // Player might already be initialized from a previous session
        console.log('[RootLayout] Track Player init error (may be already initialized):', error);
      }
    };

    if (mounted) {
      initTrackPlayer();
    }

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </GestureHandlerRootView>
  );
}
