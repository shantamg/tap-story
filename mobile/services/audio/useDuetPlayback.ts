/**
 * useDuetPlayback - React hook for duet playback with track player
 *
 * Provides a clean interface for:
 * - Loading and playing backing tracks
 * - Time stretching (speed without pitch change)
 * - Position tracking with latency compensation
 * - Recording cue callbacks
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { DuetTrackPlayer, DuetSegment } from './DuetTrackPlayer';
import { LATENCY_OFFSET_MS } from './trackPlayerSetup';

export interface UseDuetPlaybackReturn {
  // State
  isPlaying: boolean;
  isPaused: boolean;
  isLoading: boolean;
  currentPosition: number;  // Current timeline position in seconds
  totalDuration: number;    // Total duration of loaded content
  playbackRate: number;     // Current playback rate (1.0 = normal)

  // Basic Controls
  loadChain: (chain: DuetSegment[]) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  seekTo: (position: number) => Promise<void>;

  // Duet-Specific Controls
  playFrom: (
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ) => Promise<void>;

  // Time Stretching
  setPlaybackRate: (rate: number) => Promise<void>;

  // Sync Functions
  getCorrectedRecordingStartTime: (customLatencyMs?: number) => Promise<number>;
  getCurrentPositionSync: () => Promise<number>;

  // Cleanup
  cleanup: () => Promise<void>;
}

export function useDuetPlayback(): UseDuetPlaybackReturn {
  // Player instance
  const playerRef = useRef<DuetTrackPlayer | null>(null);

  // State
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1.0);

  // Position tracking interval
  const positionIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Get or create player instance
  const getPlayer = useCallback(() => {
    if (!playerRef.current) {
      playerRef.current = new DuetTrackPlayer();
    }
    return playerRef.current;
  }, []);

  // Start position tracking
  const startPositionTracking = useCallback(() => {
    stopPositionTracking();

    positionIntervalRef.current = setInterval(async () => {
      const player = playerRef.current;
      if (!player) return;

      try {
        const position = await player.getCurrentPosition();
        setCurrentPosition(position);

        // Check if playback ended
        const state = await player.getPlaybackState();
        if (state === 'stopped') {
          setIsPlaying(false);
          setIsPaused(false);
          stopPositionTracking();
        } else if (state === 'paused') {
          setIsPlaying(false);
          setIsPaused(true);
        } else if (state === 'playing') {
          setIsPlaying(true);
          setIsPaused(false);
        }
      } catch (error) {
        console.error('[useDuetPlayback] Position tracking error:', error);
      }
    }, 100); // Update every 100ms
  }, []);

  // Stop position tracking
  const stopPositionTracking = useCallback(() => {
    if (positionIntervalRef.current) {
      clearInterval(positionIntervalRef.current);
      positionIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPositionTracking();
      if (playerRef.current) {
        playerRef.current.cleanup();
        playerRef.current = null;
      }
    };
  }, [stopPositionTracking]);

  // Load a chain of segments
  const loadChain = useCallback(async (chain: DuetSegment[]) => {
    setIsLoading(true);
    try {
      const player = getPlayer();
      await player.loadChain(chain);
      setTotalDuration(player.getTotalDuration());
      setCurrentPosition(0);
    } finally {
      setIsLoading(false);
    }
  }, [getPlayer]);

  // Play from current position
  const play = useCallback(async () => {
    const player = getPlayer();
    await player.play();
    setIsPlaying(true);
    setIsPaused(false);
    startPositionTracking();
  }, [getPlayer, startPositionTracking]);

  // Pause playback
  const pause = useCallback(async () => {
    const player = getPlayer();
    await player.pause();
    setIsPlaying(false);
    setIsPaused(true);
    // Keep position tracking to maintain current position
  }, [getPlayer]);

  // Stop playback
  const stop = useCallback(async () => {
    const player = getPlayer();
    await player.stop();
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentPosition(0);
    stopPositionTracking();
  }, [getPlayer, stopPositionTracking]);

  // Seek to position
  const seekTo = useCallback(async (position: number) => {
    const player = getPlayer();
    await player.seekTo(position);
    setCurrentPosition(position);
  }, [getPlayer]);

  // Play from specific position with optional callback
  const playFrom = useCallback(async (
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ) => {
    const player = getPlayer();
    await player.playFrom(position, callbackTime, onReachTime);
    setIsPlaying(true);
    setIsPaused(false);
    setCurrentPosition(position);
    startPositionTracking();
  }, [getPlayer, startPositionTracking]);

  // Set playback rate (time stretching)
  const setPlaybackRate = useCallback(async (rate: number) => {
    const player = getPlayer();
    await player.setPlaybackRate(rate);
    setPlaybackRateState(rate);
  }, [getPlayer]);

  // Get corrected recording start time (with latency compensation)
  const getCorrectedRecordingStartTime = useCallback(async (
    customLatencyMs?: number
  ): Promise<number> => {
    const player = getPlayer();
    return player.getCorrectedRecordingStartTime(customLatencyMs);
  }, [getPlayer]);

  // Get current position (synchronous access to latest tracked position)
  const getCurrentPositionSync = useCallback(async (): Promise<number> => {
    const player = getPlayer();
    return player.getCurrentPosition();
  }, [getPlayer]);

  // Cleanup
  const cleanup = useCallback(async () => {
    stopPositionTracking();
    if (playerRef.current) {
      await playerRef.current.cleanup();
      playerRef.current = null;
    }
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentPosition(0);
    setTotalDuration(0);
    setPlaybackRateState(1.0);
  }, [stopPositionTracking]);

  return {
    // State
    isPlaying,
    isPaused,
    isLoading,
    currentPosition,
    totalDuration,
    playbackRate,

    // Basic Controls
    loadChain,
    play,
    pause,
    stop,
    seekTo,

    // Duet-Specific Controls
    playFrom,

    // Time Stretching
    setPlaybackRate,

    // Sync Functions
    getCorrectedRecordingStartTime,
    getCurrentPositionSync,

    // Cleanup
    cleanup,
  };
}

