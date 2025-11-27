/**
 * DuetTrackPlayer - Playback service for duet recording
 *
 * Key Features:
 * - Simultaneous multi-track playback (overlapping segments)
 * - Time stretching (speed change without pitch change)
 * - Precise position tracking for recording sync
 * - Configurable latency offset compensation
 * - Native module support for perfect sync (Android: Oboe C++)
 */
import { Audio } from 'expo-av';
import { Platform, NativeEventEmitter, NativeModules } from 'react-native';
import { LATENCY_OFFSET_MS } from './trackPlayerSetup';
import { localAudioExists, getLocalAudioPath, downloadAndCacheAudio } from '../audioStorage';
import { 
  isNativeModuleAvailable, 
  TapStoryAudioEngine,
  type AudioTrackInfo,
  type OnRecordingStartedCallback,
  type RecordingResult 
} from './TapStoryAudio';

// Setup the native event emitter for recording events
const { TapStoryAudio } = NativeModules;
const audioEventEmitter = TapStoryAudio ? new NativeEventEmitter(TapStoryAudio) : null;

// Default latency offset - will be replaced by smart detection
// Oboe on Android typically has round-trip latency of ~15-40ms depending on device.
const DEFAULT_ANDROID_LATENCY_MS = 24;
const DEFAULT_IOS_LATENCY_MS = 0; // iOS CoreAudio handles its own compensation well

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
  
  // Native module for synchronized audio (Android/iOS)
  private nativeEngine: TapStoryAudioEngine | null = null;
  private useNativeModule = false;
  
  // Native event listener for recording started
  private recordingListener: { remove: () => void } | null = null;
  private pendingCallbackTimeMs: number = -1;
  
  // Smart latency detection - will be measured from hardware
  private deviceLatencyMs: number = Platform.OS === 'android' 
    ? DEFAULT_ANDROID_LATENCY_MS 
    : DEFAULT_IOS_LATENCY_MS;

  constructor() {
    this.instanceId = ++instanceCounter;
    this.log('Instance created');
    
    // Check if native module is available
    this.useNativeModule = isNativeModuleAvailable();
    if (this.useNativeModule) {
      this.log('Native audio module available - using synchronized audio');
      this.nativeEngine = new TapStoryAudioEngine();
      
      // Start smart latency detection (async, will update deviceLatencyMs)
      this.detectDeviceLatency();
    } else {
      this.log('Native audio module not available - using expo-av fallback');
    }
  }

  /**
   * Smart Latency Detection
   * Queries the hardware for its specific audio latency capabilities.
   * Also checks for Bluetooth which adds significant additional lag.
   */
  private async detectDeviceLatency(): Promise<void> {
    if (Platform.OS === 'android' && TapStoryAudio) {
      try {
        // Get base hardware latency
        let latency = await TapStoryAudio.getEstimatedLatency();
        this.log(`Hardware latency detected: ${latency}ms`);
        
        // Check for Bluetooth - adds massive lag (150-300ms)
        try {
          const isBluetooth = await TapStoryAudio.isBluetoothConnected();
          if (isBluetooth) {
            const bluetoothBuffer = 200; // Conservative estimate for BT transmission
            this.log(`Bluetooth detected! Adding ${bluetoothBuffer}ms safety buffer`);
            latency += bluetoothBuffer;
          }
        } catch (btError) {
          this.log('Could not check Bluetooth status:', btError);
        }
        
        this.deviceLatencyMs = latency;
        this.log(`Final device latency: ${this.deviceLatencyMs}ms`);
      } catch (error) {
        this.log('Failed to get smart latency, using default:', error);
        this.deviceLatencyMs = DEFAULT_ANDROID_LATENCY_MS;
      }
    } else if (Platform.OS === 'ios') {
      // iOS CoreAudio is extremely consistent.
      // 0ms is often correct because iOS handles its own latency compensation well,
      // or you can use a small constant like 10ms if recordings are slightly late.
      this.deviceLatencyMs = DEFAULT_IOS_LATENCY_MS;
      this.log(`iOS latency set to: ${this.deviceLatencyMs}ms`);
    }
  }

  /**
   * Get the current detected device latency in milliseconds
   */
  getDeviceLatencyMs(): number {
    return this.deviceLatencyMs;
  }

  /**
   * Re-detect device latency (call when audio devices change, e.g., Bluetooth connects)
   */
  async refreshLatencyDetection(): Promise<number> {
    await this.detectDeviceLatency();
    return this.deviceLatencyMs;
  }

  private log(...args: unknown[]): void {
    console.log(`[DuetTrackPlayer #${this.instanceId}]`, ...args);
  }

  /**
   * Check if using native module
   */
  isUsingNativeModule(): boolean {
    return this.useNativeModule && this.nativeEngine !== null;
  }

  /**
   * Initialize the player.
   */
  async initialize(): Promise<void> {
    if (this.nativeEngine) {
      await this.nativeEngine.initialize();
      this.log('Native audio engine initialized');
    } else {
      this.log('Initialized (expo-av fallback)');
    }
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

    // Store segments
    this.segments = chain.map(node => ({
      ...node,
    }));
    
    // If using native module, load tracks natively
    if (this.nativeEngine) {
      const nativeTracks: AudioTrackInfo[] = [];
      
      for (const segment of this.segments) {
        const uri = await this.getPlaybackUri(segment);
        nativeTracks.push({
          id: segment.id,
          uri: uri,
          startTimeMs: segment.startTime * 1000, // Convert to ms
        });
        this.log(
          `Segment ${segment.id.slice(0, 8)}: starts at ${segment.startTime}s, ` +
          `duration ${segment.duration}s, ends at ${segment.startTime + segment.duration}s`
        );
      }
      
      await this.nativeEngine.loadTracks(nativeTracks);
      this.log('Chain loaded via native module');
      return;
    }

    // Fallback: Preload all sounds using expo-av
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

    this.log('Chain loaded successfully (expo-av)');
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
    // If using native module, get hardware-accurate position
    if (this.nativeEngine) {
      const positionMs = await this.nativeEngine.getCurrentPositionMs();
      return positionMs / 1000;
    }
    
    // Fallback: calculate from elapsed time
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
   * 
   * @param position Position to start from in seconds
   * @param callbackTime Optional time at which to trigger the callback (seconds)
   * @param onReachTime Callback when callbackTime is reached
   */
  async playFrom(
    position: number,
    callbackTime?: number,
    onReachTime?: () => void
  ): Promise<void> {
    this.log(`playFrom: position=${position}s, callbackTime=${callbackTime}s`);

    // Clean up any previous recording listener to avoid duplicates
    if (this.recordingListener) {
      this.recordingListener.remove();
      this.recordingListener = null;
    }

    this.isPlaying = true;
    this.timelineStartPosition = position;
    this.playbackStartTime = Date.now();
    this.startedSegments.clear();
    this.callbackTime = callbackTime;
    this.onReachTimeCallback = onReachTime;
    this.callbackTriggered = false;

    // If using native module, use native playback (or playAndRecord if callback needed)
    if (this.nativeEngine) {
      const positionMs = position * 1000;
      const callbackTimeMs = callbackTime !== undefined ? callbackTime * 1000 : -1;
      this.pendingCallbackTimeMs = callbackTimeMs;
      
      if (callbackTime !== undefined && onReachTime) {
        // Set up event listener BEFORE calling native method
        if (audioEventEmitter) {
          this.recordingListener = audioEventEmitter.addListener(
            'onRecordingStarted',
            (event: { actualStartMs: number }) => {
              this.log(`Native recording started event: ${event.actualStartMs}ms`);
              
              // Verify this is the recording we expect (within 100ms tolerance)
              if (Math.abs(event.actualStartMs - this.pendingCallbackTimeMs) < 100) {
                this.callbackTriggered = true;
                onReachTime(); // Triggers UI to show "Recording" state
              }
            }
          );
        }

        // Use playAndRecord for synchronized recording trigger
        this.log(`Native playAndRecord: position=${positionMs}ms, recordAt=${callbackTimeMs}ms`);
        await this.nativeEngine.playAndRecord(positionMs, callbackTimeMs);
      } else {
        // Simple playback
        this.log(`Native play: position=${positionMs}ms`);
        await this.nativeEngine.play(positionMs);
      }
      return;
    }

    // Fallback: expo-av playback
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

    // Clean up recording listener
    if (this.recordingListener) {
      this.recordingListener.remove();
      this.recordingListener = null;
    }

    // If using native module, stop natively
    if (this.nativeEngine) {
      await this.nativeEngine.stop();
      return;
    }

    // Fallback: stop expo-av sounds
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

  /**
   * Stop recording and get the result with latency compensation applied.
   * This adjusts the startTimeMs to account for audio round-trip latency.
   * 
   * @returns Recording result with adjusted timing, or null if not recording
   */
  async stopRecording(): Promise<RecordingResult | null> {
    this.log('stopRecording');

    // Clean up recording listener
    if (this.recordingListener) {
      this.recordingListener.remove();
      this.recordingListener = null;
    }

    if (!this.nativeEngine) {
      this.log('No native engine available for recording');
      return null;
    }

    const result = await this.nativeEngine.stopRecording();

    if (result) {
      // Apply smart latency compensation
      // We subtract the detected hardware latency from the start time.
      // This tells the timeline: "This track actually started earlier than the hardware reported."
      const adjustedStartTimeMs = Math.max(0, result.startTimeMs - this.deviceLatencyMs);
      
      this.log(
        `Sync Adjustment: Raw=${result.startTimeMs}ms, ` +
        `Adjusted=${adjustedStartTimeMs}ms (Smart Offset: -${this.deviceLatencyMs}ms), ` +
        `duration=${result.durationMs}ms`
      );

      return {
        uri: result.uri,
        durationMs: result.durationMs,
        startTimeMs: adjustedStartTimeMs, // Key fix for synchronization
      };
    }

    return null;
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

    // Clean up recording listener
    if (this.recordingListener) {
      this.recordingListener.remove();
      this.recordingListener = null;
    }
    this.pendingCallbackTimeMs = -1;

    // If using native module, cleanup natively
    if (this.nativeEngine) {
      await this.nativeEngine.cleanup();
      this.segments = [];
      return;
    }

    // Fallback: cleanup expo-av sounds
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
  
  /**
   * Get the native engine for direct access (e.g., for recording)
   * Returns null if not using native module
   */
  getNativeEngine(): TapStoryAudioEngine | null {
    return this.nativeEngine;
  }
}

