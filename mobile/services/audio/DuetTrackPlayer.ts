/**
 * DuetTrackPlayer - Playback service for duet recording using expo-av
 *
 * Key Features:
 * - Simultaneous multi-track playback (overlapping segments)
 * - Time stretching (speed change without pitch change)
 * - Precise position tracking for recording sync
 * - Configurable latency offset compensation
 */
import { Audio } from 'expo-av';
import { LATENCY_OFFSET_MS } from './trackPlayerSetup';
import { localAudioExists, getLocalAudioPath, downloadAndCacheAudio } from '../audioStorage';

export interface DuetSegment {
  id: string;
  audioUrl: string;        // Remote URL or local file URI
  localUri?: string;       // Local cached URI (preferred for playback)
  duration: number;        // Duration in seconds
  startTime: number;       // When this segment starts in the timeline
}

interface LoadedSegment extends DuetSegment {
  sound?: Audio.Sound;
}

// Compatibility export
export const PlaybackState = {
  Playing: 'playing',
  Paused: 'paused',
  Stopped: 'stopped',
} as const;

let instanceCounter = 0;

export class DuetTrackPlayer {
  private instanceId: number;
  private segments: LoadedSegment[] = [];
  private currentRate: number = 1.0;
  private isPlaying = false;
  private playbackStartTime = 0;
  private timelineStartPosition = 0;
  private callbackTime?: number;
  private onReachTimeCallback?: () => void;
  private positionCheckInterval?: NodeJS.Timeout;
  private callbackTriggered = false;
  private startedSegments: Set<string> = new Set();

  constructor() {
    this.instanceId = ++instanceCounter;
    this.log('Instance created');
  }

  private log(...args: unknown[]): void {
    console.log(`[DuetTrackPlayer #${this.instanceId}]`, ...args);
  }

  /**
   * Initialize the player. No-op for expo-av (no setup required).
   */
  async initialize(): Promise<void> {
    this.log('Initialized');
  }

  /**
   * Get the best URI to use for playback - local if available, otherwise remote
   */
  private async getPlaybackUri(segment: DuetSegment): Promise<string> {
    if (segment.localUri) {
      return segment.localUri;
    }

    const hasLocal = await localAudioExists(segment.id);
    if (hasLocal) {
      return getLocalAudioPath(segment.id);
    }

    try {
      const localPath = await downloadAndCacheAudio(segment.audioUrl, segment.id);
      return localPath;
    } catch (error) {
      console.warn('Failed to cache audio, using remote URL:', error);
      return segment.audioUrl;
    }
  }

  /**
   * Load a chain of audio segments for playback.
   * Preloads all sounds for immediate simultaneous playback.
   */
  async loadChain(chain: DuetSegment[]): Promise<void> {
    this.log('Loading chain with', chain.length, 'segments');

    // Clean up existing sounds
    await this.cleanup();

    if (chain.length === 0) {
      this.log('Empty chain, nothing to load');
      return;
    }

    // Store segments and preload all sounds
    this.segments = chain.map(node => ({
      ...node,
    }));

    // Preload all sounds
    for (const segment of this.segments) {
      const uri = await this.getPlaybackUri(segment);
      this.log(`Preloading segment ${segment.id.slice(0, 8)}`);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false, rate: this.currentRate, shouldCorrectPitch: true }
      );
      segment.sound = sound;
    }

    // Log the timeline
    for (const seg of this.segments) {
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
   * Uses expo-av's shouldCorrectPitch for time stretching.
   */
  async setPlaybackRate(rate: number): Promise<void> {
    const clampedRate = Math.max(0.25, Math.min(4.0, rate));
    this.currentRate = clampedRate;

    // Update rate on all loaded sounds
    for (const segment of this.segments) {
      if (segment.sound) {
        await segment.sound.setRateAsync(clampedRate, true); // shouldCorrectPitch = true
      }
    }
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
   */
  async getCurrentPosition(): Promise<number> {
    if (!this.isPlaying) {
      return this.timelineStartPosition;
    }
    const elapsedMs = Date.now() - this.playbackStartTime;
    return this.timelineStartPosition + (elapsedMs / 1000) * this.currentRate;
  }

  /**
   * Get the current playback state.
   */
  async getPlaybackState(): Promise<string> {
    if (this.isPlaying) return 'playing';
    return 'stopped';
  }

  /**
   * CRITICAL SYNC FUNCTION - Get corrected recording start time.
   */
  async getCorrectedRecordingStartTime(
    customLatencyOffsetMs?: number
  ): Promise<number> {
    const currentPosition = await this.getCurrentPosition();
    const latencyOffset = (customLatencyOffsetMs ?? LATENCY_OFFSET_MS) / 1000;
    const correctedPosition = Math.max(0, currentPosition - latencyOffset);
    return correctedPosition;
  }

  /**
   * Start playback from a specific position in the timeline.
   * Plays all segments simultaneously based on their start times.
   */
  async playFrom(
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ): Promise<void> {
    this.log(`playFrom: position=${position}s, callbackTime=${callbackTime}s`);

    this.isPlaying = true;
    this.timelineStartPosition = position;
    this.playbackStartTime = Date.now();
    this.startedSegments.clear();
    this.callbackTime = callbackTime;
    this.onReachTimeCallback = onReachTime;
    this.callbackTriggered = false;

    // Start all segments that should be playing at this position
    for (const segment of this.segments) {
      const segmentEnd = segment.startTime + segment.duration;

      if (segment.startTime <= position && segmentEnd > position) {
        const segmentPosition = position - segment.startTime;
        this.log(`Starting segment ${segment.id.slice(0, 8)} at position ${segmentPosition}s`);

        if (segment.sound) {
          await segment.sound.setPositionAsync(segmentPosition * 1000);
          await segment.sound.playAsync();
          this.startedSegments.add(segment.id);
        }
      }
    }

    // Set up position monitoring
    this.startPositionMonitoring();
  }

  /**
   * Monitor position and start/stop segments as needed.
   */
  private startPositionMonitoring(): void {
    this.stopPositionMonitoring();

    this.positionCheckInterval = setInterval(async () => {
      if (!this.isPlaying) {
        this.stopPositionMonitoring();
        return;
      }

      const currentPos = await this.getCurrentPosition();

      // Check callback
      if (!this.callbackTriggered && this.callbackTime !== undefined && this.onReachTimeCallback) {
        if (currentPos >= this.callbackTime) {
          this.log(`Reached callback time: ${this.callbackTime}s`);
          this.callbackTriggered = true;
          this.onReachTimeCallback();
        }
      }

      // Start segments that should begin now
      for (const segment of this.segments) {
        if (this.startedSegments.has(segment.id)) continue;
        if (!segment.sound) continue;

        const segmentEnd = segment.startTime + segment.duration;
        if (segment.startTime <= currentPos && segmentEnd > currentPos) {
          this.startedSegments.add(segment.id);
          const segmentPosition = currentPos - segment.startTime;
          this.log(`Starting segment ${segment.id.slice(0, 8)} at ${segmentPosition.toFixed(1)}s`);

          try {
            await segment.sound.setPositionAsync(segmentPosition * 1000);
            await segment.sound.playAsync();
          } catch (error) {
            this.log(`Error starting segment:`, error);
          }
        }
      }

      // Check if playback is done
      const totalDuration = this.getTotalDuration();
      if (currentPos >= totalDuration) {
        this.log('Reached end of timeline');
        this.isPlaying = false;
        this.stopPositionMonitoring();
      }
    }, 50);
  }

  private stopPositionMonitoring(): void {
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = undefined;
    }
  }

  async pause(): Promise<void> {
    this.log('pause');
    this.stopPositionMonitoring();
    this.isPlaying = false;

    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.pauseAsync();
        } catch (error) {
          this.log('Error pausing:', error);
        }
      }
    }
  }

  async play(): Promise<void> {
    this.log('play');
    this.isPlaying = true;
    this.playbackStartTime = Date.now();

    for (const segment of this.segments) {
      if (segment.sound && this.startedSegments.has(segment.id)) {
        await segment.sound.playAsync();
      }
    }

    if (!this.callbackTriggered && this.callbackTime !== undefined && this.onReachTimeCallback) {
      this.startPositionMonitoring();
    }
  }

  async stop(): Promise<void> {
    this.log('stop');
    this.stopPositionMonitoring();
    this.isPlaying = false;
    this.callbackTriggered = false;
    this.startedSegments.clear();

    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.stopAsync();
        } catch (error) {
          this.log('Error stopping:', error);
        }
      }
    }
  }

  async seekTo(position: number): Promise<void> {
    this.log(`seekTo: ${position}s`);
    this.timelineStartPosition = position;
    this.playbackStartTime = Date.now();
    this.startedSegments.clear();

    if (!this.callbackTriggered && this.callbackTime !== undefined) {
      if (position >= this.callbackTime) {
        this.callbackTriggered = true;
        this.stopPositionMonitoring();
      } else {
        this.callbackTriggered = false;
      }
    }

    // Stop all sounds first
    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.stopAsync();
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    this.log('cleanup');
    this.stopPositionMonitoring();
    this.callbackTriggered = false;
    this.callbackTime = undefined;
    this.onReachTimeCallback = undefined;
    this.isPlaying = false;
    this.startedSegments.clear();

    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.unloadAsync();
        } catch (error) {
          this.log('Error unloading:', error);
        }
        segment.sound = undefined;
      }
    }

    this.segments = [];
  }
}

