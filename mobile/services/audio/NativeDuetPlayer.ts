/**
 * NativeDuetPlayer - Duet playback using native audio module
 * 
 * Provides the same interface as DuetTrackPlayer but uses the native
 * TapStoryAudioModule for synchronized playback and recording.
 * 
 * Key benefits over expo-av:
 * - Perfect sync between playback and recording (shared audio clock)
 * - Frame-accurate timestamps
 * - Native multi-track mixing
 */
import { Platform } from 'react-native';
import { TapStoryNativeAudio, getTapStoryAudio, TrackInfo, RecordingResult } from './TapStoryNativeAudio';
import { localAudioExists, getLocalAudioPath, downloadAndCacheAudio } from '../audioStorage';

export interface DuetSegment {
  id: string;
  audioUrl: string;        // Remote URL or local file URI
  localUri?: string;       // Local cached URI (preferred for playback)
  duration: number;        // Duration in seconds
  startTime: number;       // When this segment starts in the timeline (seconds)
}

export const PlaybackState = {
  Playing: 'playing',
  Paused: 'paused',
  Stopped: 'stopped',
  Recording: 'recording',
} as const;

export type PlaybackStateType = typeof PlaybackState[keyof typeof PlaybackState];

let instanceCounter = 0;

/**
 * NativeDuetPlayer - Native audio-backed duet player
 */
export class NativeDuetPlayer {
  private instanceId: number;
  private nativeAudio: TapStoryNativeAudio;
  private segments: DuetSegment[] = [];
  private currentRate: number = 1.0;
  private isPlaying = false;
  private isRecording = false;
  private currentPositionMs = 0;
  private callbackTime?: number;
  private onReachTimeCallback?: () => void;
  private callbackTriggered = false;
  private positionCheckInterval?: NodeJS.Timeout;
  private recordingStartPositionMs = 0;

  constructor() {
    this.instanceId = ++instanceCounter;
    this.nativeAudio = getTapStoryAudio();
    this.log('Instance created, native available:', this.nativeAudio.isAvailable());
  }

  private log(...args: unknown[]): void {
    console.log(`[NativeDuetPlayer #${this.instanceId}]`, ...args);
  }

  /**
   * Check if native audio is available
   */
  isNativeAvailable(): boolean {
    return this.nativeAudio.isAvailable();
  }

  /**
   * Initialize the player
   */
  async initialize(): Promise<void> {
    this.log('Initializing');
    
    if (!this.nativeAudio.isAvailable()) {
      throw new Error('Native audio module not available');
    }
    
    await this.nativeAudio.initialize();
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
   * Load a chain of audio segments for playback
   */
  async loadChain(chain: DuetSegment[]): Promise<void> {
    this.log('Loading chain with', chain.length, 'segments');

    this.segments = [...chain];

    if (chain.length === 0) {
      this.log('Empty chain, nothing to load');
      return;
    }

    // Convert to native format with local URIs
    const nativeTracks: TrackInfo[] = [];
    
    for (const segment of this.segments) {
      const uri = await this.getPlaybackUri(segment);
      nativeTracks.push({
        id: segment.id,
        uri: uri,
        startTimeMs: segment.startTime * 1000, // Convert to milliseconds
      });
      
      this.log(`Prepared track ${segment.id.slice(0, 8)}: startTime=${segment.startTime}s`);
    }

    await this.nativeAudio.loadTracks(nativeTracks);
    this.log('Chain loaded successfully');
  }

  /**
   * Get the total duration of all segments combined
   */
  getTotalDuration(): number {
    if (this.segments.length === 0) return 0;
    return Math.max(...this.segments.map(seg => seg.startTime + seg.duration));
  }

  /**
   * Get the current playback position in seconds
   */
  async getCurrentPosition(): Promise<number> {
    if (!this.isPlaying && !this.isRecording) {
      return this.currentPositionMs / 1000;
    }
    
    const positionMs = await this.nativeAudio.getCurrentPositionMs();
    this.currentPositionMs = positionMs;
    return positionMs / 1000;
  }

  /**
   * Get the current playback state
   */
  async getPlaybackState(): Promise<PlaybackStateType> {
    if (this.isRecording) return PlaybackState.Recording;
    if (this.isPlaying) return PlaybackState.Playing;
    return PlaybackState.Stopped;
  }

  /**
   * Start playback from a specific position
   * Optionally trigger a callback when reaching a specific time
   */
  async playFrom(
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ): Promise<void> {
    this.log(`playFrom: position=${position}s, callbackTime=${callbackTime}s`);

    const positionMs = position * 1000;
    this.currentPositionMs = positionMs;
    this.callbackTime = callbackTime !== undefined ? callbackTime * 1000 : undefined;
    this.onReachTimeCallback = onReachTime;
    this.callbackTriggered = false;

    // If we need to start recording at a specific time, use playAndRecord
    if (callbackTime !== undefined && onReachTime !== undefined) {
      const recordStartMs = callbackTime * 1000;
      
      this.isPlaying = true;
      
      await this.nativeAudio.playAndRecord(positionMs, recordStartMs, (actualStartMs) => {
        this.log(`Recording started at ${actualStartMs}ms`);
        this.recordingStartPositionMs = actualStartMs;
        this.isRecording = true;
        this.callbackTriggered = true;
        
        if (this.onReachTimeCallback) {
          this.onReachTimeCallback();
        }
      });
      
      // Start position monitoring
      this.startPositionMonitoring();
    } else {
      // Just playback, no recording
      this.isPlaying = true;
      this.isRecording = false;
      
      await this.nativeAudio.play(positionMs);
      this.startPositionMonitoring();
    }
  }

  /**
   * Start position monitoring
   */
  private startPositionMonitoring(): void {
    this.stopPositionMonitoring();

    this.positionCheckInterval = setInterval(async () => {
      if (!this.isPlaying && !this.isRecording) {
        this.stopPositionMonitoring();
        return;
      }

      const currentPos = await this.getCurrentPosition();
      
      // Check if playback is complete
      const totalDuration = this.getTotalDuration();
      if (!this.isRecording && currentPos >= totalDuration) {
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

  /**
   * Pause playback
   */
  async pause(): Promise<void> {
    this.log('pause');
    await this.nativeAudio.pause();
    this.isPlaying = false;
    this.stopPositionMonitoring();
  }

  /**
   * Resume playback
   */
  async play(): Promise<void> {
    this.log('play (resume)');
    await this.nativeAudio.resume();
    this.isPlaying = true;
    this.startPositionMonitoring();
  }

  /**
   * Stop playback and recording
   * Returns recording result if recording was active
   */
  async stop(): Promise<RecordingResult | null> {
    this.log('stop');
    this.stopPositionMonitoring();
    
    const wasRecording = this.isRecording;
    this.isPlaying = false;
    this.isRecording = false;
    this.callbackTriggered = false;

    // Stop playback first
    await this.nativeAudio.stop();
    
    // Then get recording result if we were recording
    if (wasRecording) {
      const result = await this.nativeAudio.stopRecording();
      if (result) {
        this.log('Recording stopped:', result);
        return result;
      }
    }
    
    return null;
  }

  /**
   * Seek to a position
   */
  async seekTo(position: number): Promise<void> {
    this.log(`seekTo: ${position}s`);
    this.currentPositionMs = position * 1000;
    await this.nativeAudio.seekTo(this.currentPositionMs);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    this.log('cleanup');
    this.stopPositionMonitoring();
    this.callbackTriggered = false;
    this.callbackTime = undefined;
    this.onReachTimeCallback = undefined;
    this.isPlaying = false;
    this.isRecording = false;
    this.segments = [];
    
    await this.nativeAudio.cleanup();
  }

  /**
   * Get the recording start position (in seconds)
   * This is the actual position when recording started, useful for sync
   */
  getRecordingStartPosition(): number {
    return this.recordingStartPositionMs / 1000;
  }

  /**
   * Start recording only (no playback)
   * Returns immediately, recording runs in background
   */
  async startRecordingOnly(): Promise<void> {
    this.log('startRecordingOnly');
    this.isRecording = true;
    this.isPlaying = false;
    this.recordingStartPositionMs = 0;
    this.currentPositionMs = 0;
    
    await this.nativeAudio.startRecording();
    this.startPositionMonitoring();
  }

  /**
   * Stop recording and get result
   */
  async stopRecording(): Promise<RecordingResult | null> {
    return this.stop();
  }
}

// Export factory function for consistency with DuetTrackPlayer
export function createNativeDuetPlayer(): NativeDuetPlayer {
  return new NativeDuetPlayer();
}

