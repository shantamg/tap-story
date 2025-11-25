/**
 * Playback Service - Handles background playback events for react-native-track-player
 *
 * This service runs in a separate headless task and handles system events
 * like play/pause from notification, lock screen, bluetooth controls, etc.
 *
 * IMPORTANT: This file must be registered in index.js or _layout.tsx
 */
import TrackPlayer, { Event } from 'react-native-track-player';

/**
 * Playback service that handles remote control events.
 * This is required by react-native-track-player and runs in the background.
 */
export async function playbackService(): Promise<void> {
  // Remote play event (from notification, lock screen, bluetooth, etc.)
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    console.log('[PlaybackService] RemotePlay event');
    TrackPlayer.play();
  });

  // Remote pause event
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log('[PlaybackService] RemotePause event');
    TrackPlayer.pause();
  });

  // Remote stop event
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log('[PlaybackService] RemoteStop event');
    TrackPlayer.stop();
  });

  // Remote seek event
  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    console.log('[PlaybackService] RemoteSeek event, position:', event.position);
    TrackPlayer.seekTo(event.position);
  });

  // Handle playback error
  TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
    console.error('[PlaybackService] PlaybackError:', event);
  });

  // Handle playback state change
  TrackPlayer.addEventListener(Event.PlaybackState, (event) => {
    console.log('[PlaybackService] PlaybackState:', event.state);
  });

  // Handle track change
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (event) => {
    console.log('[PlaybackService] ActiveTrackChanged:', event.track?.id);
  });

  // Handle playback queue ended
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, (event) => {
    console.log('[PlaybackService] QueueEnded, position:', event.position);
  });
}

