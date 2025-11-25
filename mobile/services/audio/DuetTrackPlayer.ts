/**
 * DuetTrackPlayer - Playback service for duet recording using react-native-track-player
 *
 * Key Features:
 * - Time stretching (speed change without pitch change)
 * - Precise position tracking for recording sync
 * - Configurable latency offset compensation
 *
 * IMPORTANT NOTE ON MULTI-TRACK PLAYBACK:
 * react-native-track-player is designed for single-track playback (like a music player).
 * For true simultaneous multi-track playback (overlapping segments), you have options:
 *
 * 1. Pre-mix overlapping segments server-side into a single audio file
 * 2. Use a hybrid approach: track-player for primary track + expo-av for additional tracks
 * 3. Use expo-av with setRateAsync(rate, shouldCorrectPitch: true) for time stretching
 *
 * This implementation handles the timeline by treating it as a single audio source
 * or pre-mixed backing track. For the "add to chain" feature, the server should
 * provide a pre-mixed version of all previous recordings.
 */
import TrackPlayer, {
  State,
  Track,
  Progress,
  Event,
  PlaybackState,
} from 'react-native-track-player';
import { setupTrackPlayer, LATENCY_OFFSET_MS } from './trackPlayerSetup';

export interface DuetSegment {
  id: string;
  audioUrl: string;        // Remote URL or local file URI
  localUri?: string;       // Local cached URI (preferred for playback)
  duration: number;        // Duration in seconds
  startTime: number;       // When this segment starts in the timeline
}

export { PlaybackState };

let instanceCounter = 0;

export class DuetTrackPlayer {
  private instanceId: number;
  private segments: DuetSegment[] = [];
  private currentRate: number = 1.0;
  private isInitialized = false;
  private callbackTime?: number;
  private onReachTimeCallback?: () => void;
  private positionCheckInterval?: NodeJS.Timeout;
  private callbackTriggered = false;

  constructor() {
    this.instanceId = ++instanceCounter;
    this.log('Instance created');
  }

  private log(...args: unknown[]): void {
    console.log(`[DuetTrackPlayer #${this.instanceId}]`, ...args);
  }

  /**
   * Initialize the track player. Must be called before any other operations.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await setupTrackPlayer();
    this.isInitialized = true;
    this.log('Initialized');
  }

  /**
   * Load a chain of audio segments for playback.
   *
   * For overlapping segments, consider:
   * 1. Pre-mixing them server-side into a single "backing track"
   * 2. Or use the first/primary track only for playback reference
   *
   * @param chain - Array of audio segments with timeline positions
   */
  async loadChain(chain: DuetSegment[]): Promise<void> {
    await this.initialize();
    this.log('Loading chain with', chain.length, 'segments');

    // Store segments for reference
    this.segments = [...chain];

    // Clear current queue
    await TrackPlayer.reset();

    if (chain.length === 0) {
      this.log('Empty chain, nothing to load');
      return;
    }

    // For multi-segment chains, we need to handle them specially.
    // Option 1: Play segments sequentially (no overlap)
    // Option 2: Load a pre-mixed backing track
    // Option 3: Load only the most recent segment as reference
    //
    // This implementation supports sequential playback for non-overlapping segments.
    // For overlapping segments, use the hybrid approach with expo-av.

    // Sort segments by start time
    const sortedSegments = [...chain].sort((a, b) => a.startTime - b.startTime);

    // Build the track queue
    const tracks: Track[] = sortedSegments.map((segment, index) => ({
      id: segment.id,
      url: segment.localUri || segment.audioUrl,
      title: `Segment ${index + 1}`,
      artist: 'Duet Recording',
      duration: segment.duration,
    }));

    // Add all tracks to the queue
    await TrackPlayer.add(tracks);

    // Log the timeline
    for (const seg of sortedSegments) {
      this.log(
        `Segment ${seg.id.slice(0, 8)}: starts at ${seg.startTime}s, ` +
        `duration ${seg.duration}s, ends at ${seg.startTime + seg.duration}s`
      );
    }

    this.log('Chain loaded successfully');
  }

  /**
   * Get the total duration of all segments combined.
   */
  getTotalDuration(): number {
    if (this.segments.length === 0) return 0;
    return Math.max(...this.segments.map(seg => seg.startTime + seg.duration));
  }

  /**
   * Set the playback rate (speed) without changing pitch.
   *
   * This is TIME STRETCHING - the audio plays faster/slower but maintains
   * the original pitch, unlike simple rate changes that would make voices
   * sound higher/lower.
   *
   * @param rate - Playback rate (0.5 = half speed, 1.0 = normal, 1.5 = 1.5x speed)
   *               Typical range: 0.5 to 2.0
   */
  async setPlaybackRate(rate: number): Promise<void> {
    await this.initialize();

    // Clamp rate to reasonable bounds
    const clampedRate = Math.max(0.25, Math.min(4.0, rate));
    this.currentRate = clampedRate;

    // react-native-track-player's setRate() preserves pitch by default
    // This is true for iOS (AVPlayer) and Android (ExoPlayer)
    await TrackPlayer.setRate(clampedRate);
    this.log(`Playback rate set to ${clampedRate}x`);
  }

  /**
   * Get the current playback rate.
   */
  getPlaybackRate(): number {
    return this.currentRate;
  }

  /**
   * Get the current playback position in seconds.
   * This is more accurate than using Date.now() for sync purposes.
   */
  async getCurrentPosition(): Promise<number> {
    try {
      const progress = await TrackPlayer.getProgress();
      return progress.position;
    } catch {
      return 0;
    }
  }

  /**
   * Get the buffered position (how much audio is loaded ahead).
   */
  async getBufferedPosition(): Promise<number> {
    try {
      const progress = await TrackPlayer.getProgress();
      return progress.buffered;
    } catch {
      return 0;
    }
  }

  /**
   * Get the current playback state.
   */
  async getPlaybackState(): Promise<State> {
    const playbackState = await TrackPlayer.getPlaybackState();
    return playbackState.state;
  }

  /**
   * CRITICAL SYNC FUNCTION
   *
   * Get the corrected recording start time relative to the backing track.
   *
   * This function compensates for audio output latency by subtracting
   * a configurable offset from the current playback position.
   *
   * Why this matters:
   * - When you hear audio, it's actually been processed and buffered
   * - There's typically 150-350ms delay from "player position" to "sound in ears"
   * - When recording starts, we need to know where in the backing track the user
   *   HEARD, not where the player position was
   *
   * @param customLatencyOffsetMs - Optional custom latency offset (default: LATENCY_OFFSET_MS)
   * @returns The corrected timeline position in seconds where recording should be aligned
   */
  async getCorrectedRecordingStartTime(
    customLatencyOffsetMs?: number
  ): Promise<number> {
    const currentPosition = await this.getCurrentPosition();
    const latencyOffset = (customLatencyOffsetMs ?? LATENCY_OFFSET_MS) / 1000;

    // Subtract latency to get the "perceived" position
    // This is where in the timeline the user actually heard when they started singing
    const correctedPosition = Math.max(0, currentPosition - latencyOffset);

    this.log(
      `getCorrectedRecordingStartTime: position=${currentPosition.toFixed(3)}s, ` +
      `latency=${(latencyOffset * 1000).toFixed(0)}ms, ` +
      `corrected=${correctedPosition.toFixed(3)}s`
    );

    return correctedPosition;
  }

  /**
   * Start playback from a specific position in the timeline.
   *
   * @param position - Timeline position to start from (seconds)
   * @param callbackTime - Optional time to trigger a callback (for recording cue)
   * @param onReachTime - Callback to trigger when reaching callbackTime
   */
  async playFrom(
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ): Promise<void> {
    await this.initialize();
    this.log(`playFrom: position=${position}s, callbackTime=${callbackTime}s`);

    // Store callback info
    this.callbackTime = callbackTime;
    this.onReachTimeCallback = onReachTime;
    this.callbackTriggered = false;

    // Seek to the position
    await TrackPlayer.seekTo(position);

    // Start playback
    await TrackPlayer.play();

    // Set up position monitoring for callback
    if (callbackTime !== undefined && onReachTime) {
      this.startPositionMonitoring();
    }
  }

  /**
   * Start monitoring position for callback triggering.
   */
  private startPositionMonitoring(): void {
    // Clear any existing interval
    this.stopPositionMonitoring();

    // Check position every 50ms for responsive callback triggering
    this.positionCheckInterval = setInterval(async () => {
      if (this.callbackTriggered) {
        this.stopPositionMonitoring();
        return;
      }

      if (this.callbackTime === undefined || !this.onReachTimeCallback) {
        this.stopPositionMonitoring();
        return;
      }

      const position = await this.getCurrentPosition();

      if (position >= this.callbackTime) {
        this.log(`Reached callback time: ${this.callbackTime}s at position ${position}s`);
        this.callbackTriggered = true;
        this.stopPositionMonitoring();
        this.onReachTimeCallback();
      }
    }, 50);
  }

  /**
   * Stop position monitoring.
   */
  private stopPositionMonitoring(): void {
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = undefined;
    }
  }

  /**
   * Pause playback.
   */
  async pause(): Promise<void> {
    this.log('pause');
    this.stopPositionMonitoring();
    await TrackPlayer.pause();
  }

  /**
   * Resume playback.
   */
  async play(): Promise<void> {
    this.log('play');
    await TrackPlayer.play();

    // Resume monitoring if we have a pending callback
    if (!this.callbackTriggered && this.callbackTime !== undefined && this.onReachTimeCallback) {
      this.startPositionMonitoring();
    }
  }

  /**
   * Stop playback and reset to beginning.
   */
  async stop(): Promise<void> {
    this.log('stop');
    this.stopPositionMonitoring();
    this.callbackTriggered = false;
    await TrackPlayer.stop();
    await TrackPlayer.seekTo(0);
  }

  /**
   * Seek to a specific position.
   *
   * @param position - Position in seconds
   */
  async seekTo(position: number): Promise<void> {
    this.log(`seekTo: ${position}s`);

    // If we have a callback that hasn't triggered yet, check if we're seeking past it
    if (!this.callbackTriggered && this.callbackTime !== undefined) {
      if (position >= this.callbackTime) {
        // We're seeking past the callback time, mark as triggered
        this.callbackTriggered = true;
        this.stopPositionMonitoring();
      } else {
        // We're seeking before the callback time, reset triggered state
        this.callbackTriggered = false;
      }
    }

    await TrackPlayer.seekTo(position);
  }

  /**
   * Clean up resources. Call when done with the player.
   */
  async cleanup(): Promise<void> {
    this.log('cleanup');
    this.stopPositionMonitoring();
    this.callbackTriggered = false;
    this.callbackTime = undefined;
    this.onReachTimeCallback = undefined;

    try {
      await TrackPlayer.reset();
    } catch (error) {
      this.log('Error during cleanup:', error);
    }

    this.segments = [];
  }
}

