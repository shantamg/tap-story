/**
 * TapStoryNativeAudio - TypeScript wrapper for the native audio module
 * 
 * Provides synchronized audio playback and recording using native code
 * (RemoteIO AudioUnit on iOS, Oboe FullDuplexStream on Android)
 * 
 * Key features:
 * - Frame-aligned playback/capture with route latency compensation
 * - Frame-accurate timestamps
 * - Multi-track mixing
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

// Native module interface
interface TapStoryAudioModuleInterface {
  initialize(): Promise<void>;
  loadTracks(tracks: NativeTrackInfo[]): Promise<void>;
  play(playFromMs: number): Promise<void>;
  playAndRecord(playFromMs: number, recordStartMs: number): Promise<void>;
  startRecording?(): Promise<void>;
  stop(): Promise<void>;
  stopRecording(): Promise<NativeRecordingResult | null>;
  getCurrentPositionMs(): Promise<number>;
  seekTo?(positionMs: number): Promise<void>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  cleanup(): Promise<void>;
  setLatencyCompensationMs?(latencyMs: number): Promise<void>;
  getEstimatedLatency?(): Promise<number>;
  getLatencyInfo?(): Promise<{
    inputLatencyMs?: number;
    outputLatencyMs?: number;
  }>;
  getAudioDiagnostics?(): Promise<{
    inputLatencyMs?: number;
    outputLatencyMs?: number;
  }>;
  isBluetoothConnected?(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  
  // Constants (optional)
  SAMPLE_RATE?: number;
  CHANNELS_OUT?: number;
  CHANNELS_IN?: number;
}

interface NativeTrackInfo {
  id: string;
  uri: string;
  startTimeMs: number;
}

interface NativeRecordingResult {
  uri: string;
  startTimeMs: number;
  durationMs: number;
}

// Event types
export interface PositionUpdateEvent {
  positionMs: number;
}

export interface RecordingStartedEvent {
  actualStartMs: number;
}

// Track info for loading
export interface TrackInfo {
  id: string;
  uri: string;
  startTimeMs: number;
}

// Recording result
export interface RecordingResult {
  uri: string;
  startTimeMs: number;
  durationMs: number;
}

// Event listener types
type PositionUpdateListener = (event: PositionUpdateEvent) => void;
type RecordingStartedListener = (event: RecordingStartedEvent) => void;
type PlaybackCompleteListener = () => void;

export function getAdjustedLatencyCompensationMs(
  automaticMs: number,
  adjustmentMs: number
): number {
  const automatic = Number.isFinite(automaticMs) ? Math.max(0, automaticMs) : 0;
  const adjustment = Number.isFinite(adjustmentMs)
    ? Math.max(-250, Math.min(250, adjustmentMs))
    : 0;
  return Math.max(1, Math.min(1_000, automatic + adjustment));
}

/**
 * Get the native module (with fallback for platforms where it's not available)
 */
function getNativeModule(): TapStoryAudioModuleInterface | null {
  // Try both module names (TapStoryAudio for new native module, TapStoryAudioModule for legacy)
  const { TapStoryAudio, TapStoryAudioModule } = NativeModules;
  const nativeModule = TapStoryAudio || TapStoryAudioModule;
  
  if (!nativeModule) {
    console.warn('[TapStoryNativeAudio] Native module not available on this platform');
    return null;
  }
  
  console.log('[TapStoryNativeAudio] Using native module:', TapStoryAudio ? 'TapStoryAudio' : 'TapStoryAudioModule');
  return nativeModule as TapStoryAudioModuleInterface;
}

/**
 * TapStoryNativeAudio - Main class for synchronized audio
 */
export class TapStoryNativeAudio {
  private static instance: TapStoryNativeAudio | null = null;
  
  private nativeModule: TapStoryAudioModuleInterface | null;
  private eventEmitter: NativeEventEmitter | null = null;
  private isInitialized = false;
  
  // Event subscriptions
  private positionListeners: PositionUpdateListener[] = [];
  private recordingStartedListeners: RecordingStartedListener[] = [];
  private playbackCompleteListeners: PlaybackCompleteListener[] = [];
  private pendingRecordingStartedListener: RecordingStartedListener | null = null;
  private subscriptions: { remove: () => void }[] = [];
  
  private constructor() {
    this.nativeModule = getNativeModule();
    
    if (this.nativeModule) {
      this.eventEmitter = new NativeEventEmitter(this.nativeModule as any);
      this.setupEventListeners();
    }
  }
  
  /**
   * Get singleton instance
   */
  static getInstance(): TapStoryNativeAudio {
    if (!TapStoryNativeAudio.instance) {
      TapStoryNativeAudio.instance = new TapStoryNativeAudio();
    }
    return TapStoryNativeAudio.instance;
  }
  
  /**
   * Check if native module is available
   */
  isAvailable(): boolean {
    return this.nativeModule !== null;
  }
  
  /**
   * Get audio configuration constants
   */
  getConfig(): { sampleRate: number; channelsOut: number; channelsIn: number } | null {
    if (!this.nativeModule) return null;
    
    return {
      sampleRate: this.nativeModule.SAMPLE_RATE ?? 44100,
      channelsOut: this.nativeModule.CHANNELS_OUT ?? 2,
      channelsIn: this.nativeModule.CHANNELS_IN ?? 1,
    };
  }
  
  /**
   * Initialize the audio engine
   */
  async initialize(): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    if (this.isInitialized) {
      console.log('[TapStoryNativeAudio] Already initialized');
      return;
    }
    
    console.log('[TapStoryNativeAudio] Initializing...');
    await this.nativeModule.initialize();
    this.isInitialized = true;
    console.log('[TapStoryNativeAudio] Initialized');
  }
  
  /**
   * Load tracks for synchronized playback
   */
  async loadTracks(tracks: TrackInfo[]): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    console.log('[TapStoryNativeAudio] Loading', tracks.length, 'tracks');
    
    const nativeTracks: NativeTrackInfo[] = tracks.map(track => ({
      id: track.id,
      uri: track.uri,
      startTimeMs: track.startTimeMs,
    }));
    
    await this.nativeModule.loadTracks(nativeTracks);
    console.log('[TapStoryNativeAudio] Tracks loaded');
  }
  
  /**
   * Start playback from a position
   */
  async play(playFromMs: number = 0): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    console.log('[TapStoryNativeAudio] Playing from', playFromMs, 'ms');
    await this.nativeModule.play(playFromMs);
  }
  
  /**
   * Start synchronized playback and recording
   * 
   * Recording will start exactly when playback reaches recordStartMs
   * 
   * @param playFromMs - Position to start playback from
   * @param recordStartMs - Position when recording should start
   * @param onRecordingStarted - Callback when recording actually starts (with actual timestamp)
   */
  async playAndRecord(
    playFromMs: number,
    recordStartMs: number,
    onRecordingStarted?: (actualStartMs: number) => void
  ): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    console.log('[TapStoryNativeAudio] Play and record: playFrom=', playFromMs, ', recordAt=', recordStartMs);
    
    // Add one-time listener for recording started
    if (onRecordingStarted) {
      this.clearPendingRecordingStartedListener();
      const listener = (event: RecordingStartedEvent) => {
        onRecordingStarted(event.actualStartMs);
        this.removeRecordingStartedListener(listener);
        if (this.pendingRecordingStartedListener === listener) {
          this.pendingRecordingStartedListener = null;
        }
      };
      this.pendingRecordingStartedListener = listener;
      this.addRecordingStartedListener(listener);
    }

    try {
      await this.nativeModule.playAndRecord(playFromMs, recordStartMs);
    } catch (error) {
      this.clearPendingRecordingStartedListener();
      throw error;
    }
  }
  
  /**
   * Start recording only (no playback)
   */
  async startRecording(): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    if (!this.nativeModule.startRecording) {
      // If standalone recording is not supported, use playAndRecord with 0,0
      console.log('[TapStoryNativeAudio] Starting recording via playAndRecord');
      await this.nativeModule.playAndRecord(0, 0);
      return;
    }
    
    console.log('[TapStoryNativeAudio] Starting recording only');
    await this.nativeModule.startRecording();
  }

  /**
   * Configure the total round-trip compensation used to gate captured PCM.
   * The signed value fine-tunes the platform's route estimate; zero keeps
   * automatic mode. Bluetooth is rejected because its variable buffering
   * cannot meet Tap Story's tight-overdub guarantee.
   */
  async configureLatencyCompensation(adjustmentMs: number = 0): Promise<number> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }

    if (
      Platform.OS === 'android'
      && this.nativeModule.isBluetoothConnected
      && await this.nativeModule.isBluetoothConnected()
    ) {
      throw new Error(
        'Bluetooth audio has variable latency and is not supported for synchronized overdubs. Use the built-in route or wired headphones.'
      );
    }

    const boundedAdjustmentMs = Number.isFinite(adjustmentMs)
      ? Math.max(-250, Math.min(250, adjustmentMs))
      : 0;
    let automaticMs = 0;
    if (this.nativeModule.getEstimatedLatency) {
      const estimatedMs = await this.nativeModule.getEstimatedLatency();
      if (!Number.isFinite(estimatedMs) || estimatedMs <= 0) {
        throw new Error(
          'The Android audio route did not provide a usable latency timestamp. Run a wired-route calibration before recording an overdub.'
        );
      }
      automaticMs = estimatedMs;
    } else if (this.nativeModule.getLatencyInfo) {
      const latency = await this.nativeModule.getLatencyInfo();
      automaticMs = Math.max(
        0,
        (latency.inputLatencyMs ?? 0) + (latency.outputLatencyMs ?? 0)
      );
    }

    const useNativeAutomatic = boundedAdjustmentMs === 0 && Platform.OS === 'ios';
    const compensationMs = useNativeAutomatic
      ? 0
      : getAdjustedLatencyCompensationMs(automaticMs, boundedAdjustmentMs);
    if (this.nativeModule.setLatencyCompensationMs) {
      await this.nativeModule.setLatencyCompensationMs(compensationMs);
    }
    return useNativeAutomatic
      ? automaticMs
      : compensationMs;
  }

  /**
   * A standalone first take has no output reference. Its timeline must be
   * gated and tailed by microphone input latency only.
   */
  async configureCaptureOnlyLatencyCompensation(): Promise<number> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }

    const latency = this.nativeModule.getLatencyInfo
      ? await this.nativeModule.getLatencyInfo()
      : this.nativeModule.getAudioDiagnostics
        ? await this.nativeModule.getAudioDiagnostics()
        : {};
    const inputLatencyMs = latency.inputLatencyMs ?? 0;
    const compensationMs = Number.isFinite(inputLatencyMs) && inputLatencyMs > 0
      ? Math.min(1_000, inputLatencyMs)
      : 0;
    if (this.nativeModule.setLatencyCompensationMs) {
      await this.nativeModule.setLatencyCompensationMs(compensationMs);
    }
    return compensationMs;
  }
  
  /**
   * Stop playback only
   */
  async stop(): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    console.log('[TapStoryNativeAudio] Stopping playback');
    await this.nativeModule.stop();
  }
  
  /**
   * Stop recording and get the result
   * Returns recording result if recording was active
   */
  async stopRecording(): Promise<RecordingResult | null> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    console.log('[TapStoryNativeAudio] Stopping recording');
    try {
      const result = await this.nativeModule.stopRecording();

      if (result) {
        console.log('[TapStoryNativeAudio] Recording result:', result);
        return {
          uri: result.uri,
          startTimeMs: result.startTimeMs,
          durationMs: result.durationMs,
        };
      }

      return null;
    } finally {
      this.clearPendingRecordingStartedListener();
    }
  }
  
  /**
   * Stop both playback and recording
   * Returns recording result if recording was active
   */
  async stopAll(): Promise<RecordingResult | null> {
    await this.stop();
    return this.stopRecording();
  }
  
  /**
   * Get current playback position in milliseconds
   */
  async getCurrentPositionMs(): Promise<number> {
    if (!this.nativeModule) {
      return 0;
    }
    
    return this.nativeModule.getCurrentPositionMs();
  }
  
  /**
   * Seek to a position
   */
  async seekTo(positionMs: number): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    if (this.nativeModule.seekTo) {
      await this.nativeModule.seekTo(positionMs);
    } else {
      console.warn('[TapStoryNativeAudio] seekTo not implemented in native module');
    }
  }
  
  /**
   * Pause playback
   */
  async pause(): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    if (this.nativeModule.pause) {
      await this.nativeModule.pause();
    } else {
      // Fall back to stop if pause is not available
      await this.nativeModule.stop();
    }
  }
  
  /**
   * Resume playback
   */
  async resume(): Promise<void> {
    if (!this.nativeModule) {
      throw new Error('Native audio module not available');
    }
    
    if (this.nativeModule.resume) {
      await this.nativeModule.resume();
    } else {
      console.warn('[TapStoryNativeAudio] resume not implemented in native module');
    }
  }
  
  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (!this.nativeModule) {
      return;
    }
    
    console.log('[TapStoryNativeAudio] Cleaning up');
    try {
      await this.nativeModule.cleanup();
    } finally {
      this.clearPendingRecordingStartedListener();
      this.isInitialized = false;
    }
  }
  
  // Event listener management
  
  /**
   * Add position update listener
   */
  addPositionUpdateListener(listener: PositionUpdateListener): void {
    this.positionListeners.push(listener);
  }
  
  /**
   * Remove position update listener
   */
  removePositionUpdateListener(listener: PositionUpdateListener): void {
    const index = this.positionListeners.indexOf(listener);
    if (index !== -1) {
      this.positionListeners.splice(index, 1);
    }
  }
  
  /**
   * Add recording started listener
   */
  addRecordingStartedListener(listener: RecordingStartedListener): void {
    this.recordingStartedListeners.push(listener);
  }
  
  /**
   * Remove recording started listener
   */
  removeRecordingStartedListener(listener: RecordingStartedListener): void {
    const index = this.recordingStartedListeners.indexOf(listener);
    if (index !== -1) {
      this.recordingStartedListeners.splice(index, 1);
    }
  }

  private clearPendingRecordingStartedListener(): void {
    if (!this.pendingRecordingStartedListener) return;
    this.removeRecordingStartedListener(this.pendingRecordingStartedListener);
    this.pendingRecordingStartedListener = null;
  }
  
  /**
   * Add playback complete listener
   */
  addPlaybackCompleteListener(listener: PlaybackCompleteListener): void {
    this.playbackCompleteListeners.push(listener);
  }
  
  /**
   * Remove playback complete listener
   */
  removePlaybackCompleteListener(listener: PlaybackCompleteListener): void {
    const index = this.playbackCompleteListeners.indexOf(listener);
    if (index !== -1) {
      this.playbackCompleteListeners.splice(index, 1);
    }
  }
  
  /**
   * Setup native event listeners
   */
  private setupEventListeners(): void {
    if (!this.eventEmitter) return;
    
    // Position update
    const positionSub = this.eventEmitter.addListener('onPositionUpdate', (event: PositionUpdateEvent) => {
      this.positionListeners.forEach(listener => listener(event));
    });
    this.subscriptions.push(positionSub);
    
    // Recording started
    const recordingSub = this.eventEmitter.addListener('onRecordingStarted', (event: RecordingStartedEvent) => {
      this.recordingStartedListeners.forEach(listener => listener(event));
    });
    this.subscriptions.push(recordingSub);
    
    // Playback complete
    const completeSub = this.eventEmitter.addListener('onPlaybackComplete', () => {
      this.playbackCompleteListeners.forEach(listener => listener());
    });
    this.subscriptions.push(completeSub);
  }
  
  /**
   * Destroy the instance (for cleanup)
   */
  destroy(): void {
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
    this.positionListeners = [];
    this.recordingStartedListeners = [];
    this.playbackCompleteListeners = [];
    this.pendingRecordingStartedListener = null;
    TapStoryNativeAudio.instance = null;
  }
}

// Export singleton getter for convenience
export function getTapStoryAudio(): TapStoryNativeAudio {
  return TapStoryNativeAudio.getInstance();
}

// Export a hook-friendly version
export function useTapStoryAudio(): TapStoryNativeAudio {
  return TapStoryNativeAudio.getInstance();
}
