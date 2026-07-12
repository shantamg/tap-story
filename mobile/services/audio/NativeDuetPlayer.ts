/**
 * NativeDuetPlayer - Duet playback using native audio module
 * 
 * Provides the same interface as DuetTrackPlayer but uses the native
 * TapStoryAudioModule for synchronized playback and recording.
 * 
 * Key benefits over expo-av:
 * - Frame-aligned playback and capture with route compensation
 * - Frame-accurate timestamps
 * - Native multi-track mixing
 */
import { TapStoryNativeAudio, getTapStoryAudio, TrackInfo, RecordingResult } from './TapStoryNativeAudio';
import { findCachedAudioPath, downloadAndCacheAudio } from '../audioStorage';

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

interface TransportSession {
  id: number;
  capturesAudio: boolean;
  captureStarted: boolean;
  cancelled: boolean;
  cancelledPromise: Promise<void>;
  signalCancelled: () => void;
}

interface SessionCancelledError extends Error {
  code: 'SESSION_CANCELLED';
}

function createSessionCancelledError(): SessionCancelledError {
  const error = new Error('Audio transport session was cancelled') as SessionCancelledError;
  error.name = 'SessionCancelledError';
  error.code = 'SESSION_CANCELLED';
  return error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

// Native transport-start rejections that mean the engine went stale (route
// change/interruption) and can be recovered by reinitializing and reloading.
// iOS rejects with *_START_ERROR codes (RECORD_START_ERROR at the capture-arm
// stage, before the transport starts); Android with PLAY_ERROR/PLAY_RECORD_ERROR.
const RECOVERABLE_START_ERROR_CODES = [
  'PLAY_START_ERROR',
  'PLAY_RECORD_START_ERROR',
  'RECORD_START_ERROR',
  'PLAY_ERROR',
  'PLAY_RECORD_ERROR',
];

function isRecoverableStartError(error: unknown): boolean {
  return RECOVERABLE_START_ERROR_CODES.some(code => hasErrorCode(error, code));
}

/**
 * NativeDuetPlayer - Native audio-backed duet player
 */
export class NativeDuetPlayer {
  private instanceId: number;
  private nativeAudio: TapStoryNativeAudio;
  private segments: DuetSegment[] = [];
  private isPlaying = false;
  private isRecording = false;
  private currentPositionMs = 0;
  private callbackTriggered = false;
  private positionCheckInterval?: NodeJS.Timeout;
  private recordingStartPositionMs = 0;
  private initialized = false;
  private initializationPromise?: Promise<void>;
  private sessionCounter = 0;
  private activeSession?: TransportSession;
  private onPlaybackComplete?: () => void;
  // The last capture-latency configuration applied to the engine. A route
  // change destroys the native engine's compensation, so a rebuild-and-retry
  // must re-apply it or the retried overdub lands mis-synced on Android.
  private lastCaptureCompensation?:
    | { mode: 'overdub'; adjustmentMs: number }
    | { mode: 'captureOnly' };

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
    if (this.initialized) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeNativeAudio();
    }

    const pendingInitialization = this.initializationPromise;
    try {
      await pendingInitialization;
    } finally {
      if (this.initializationPromise === pendingInitialization) {
        this.initializationPromise = undefined;
      }
    }
  }

  private async initializeNativeAudio(): Promise<void> {
    this.log('Initializing');
    
    if (!this.nativeAudio.isAvailable()) {
      throw new Error('Native audio module not available');
    }
    
    await this.nativeAudio.initialize();
    this.initialized = true;
    this.log('Initialized');
  }

  async configureLatencyCompensation(adjustmentMs: number = 0): Promise<number> {
    await this.ensureInitialized();
    const appliedMs = await this.nativeAudio.configureLatencyCompensation(adjustmentMs);
    this.lastCaptureCompensation = { mode: 'overdub', adjustmentMs };
    this.log(`Capture latency compensation: ${appliedMs.toFixed(2)}ms`);
    return appliedMs;
  }

  /**
   * Register a callback fired once when playback reaches the end of the
   * timeline and the transport auto-stops. Without this the UI cannot tell
   * playback finished and wedges in a "playing" state.
   */
  setOnPlaybackComplete(callback: (() => void) | undefined): void {
    this.onPlaybackComplete = callback;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private beginSession(capturesAudio: boolean): TransportSession {
    this.cancelActiveSession();

    let signalCancelled: () => void = () => undefined;
    const cancelledPromise = new Promise<void>(resolve => {
      signalCancelled = resolve;
    });
    const session: TransportSession = {
      id: ++this.sessionCounter,
      capturesAudio,
      captureStarted: false,
      cancelled: false,
      cancelledPromise,
      signalCancelled,
    };
    this.activeSession = session;
    return session;
  }

  private isSessionActive(session: TransportSession): boolean {
    return this.activeSession === session && !session.cancelled;
  }

  private assertSessionActive(session: TransportSession): void {
    if (!this.isSessionActive(session)) {
      throw createSessionCancelledError();
    }
  }

  private cancelActiveSession(): TransportSession | undefined {
    const session = this.activeSession;
    if (!session) return undefined;

    this.activeSession = undefined;
    if (!session.cancelled) {
      session.cancelled = true;
      session.signalCancelled();
    }
    return session;
  }

  private async cleanupFailedSession(session: TransportSession): Promise<void> {
    if (!this.isSessionActive(session)) return;
    this.isPlaying = false;
    this.isRecording = false;
    await this.cleanup();
  }

  /**
   * Get the best URI to use for playback - local if available, otherwise remote
   */
  private async getPlaybackUri(segment: DuetSegment): Promise<string> {
    if (segment.localUri) {
      return segment.localUri;
    }

    const cachedPath = await findCachedAudioPath(segment.id);
    if (cachedPath) {
      return cachedPath;
    }

    try {
      const localPath = await downloadAndCacheAudio(segment.audioUrl, segment.id);
      return localPath;
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(
        `Failed to prepare audio segment ${segment.id} for native playback${detail}`
      );
    }
  }

  /**
   * Load a chain of audio segments for playback
   */
  async loadChain(chain: DuetSegment[]): Promise<void> {
    await this.ensureInitialized();
    this.log('Loading chain with', chain.length, 'segments');

    this.segments = [...chain];

    if (chain.length === 0) {
      await this.nativeAudio.loadTracks([]);
      this.log('Empty chain, native mixer cleared');
      return;
    }

    await this.nativeAudio.loadTracks(await this.prepareNativeTracks());
    this.log('Chain loaded successfully');
  }

  /**
   * Convert the loaded segments to native track descriptors with local URIs
   */
  private async prepareNativeTracks(): Promise<TrackInfo[]> {
    const nativeTracks: TrackInfo[] = [];

    for (const segment of this.segments) {
      const uri = await this.getPlaybackUri(segment);
      nativeTracks.push({
        id: segment.id,
        uri: uri,
        startTimeMs: Math.round(segment.startTime * 1000),
      });

      this.log(`Prepared track ${segment.id.slice(0, 8)}: startTime=${segment.startTime}s`);
    }

    return nativeTracks;
  }

  /**
   * A route change/interruption invalidates the native engine. Rebuild it and
   * reload the current tracks so a transport start can be retried.
   */
  private async rebuildEngineForSession(session: TransportSession): Promise<void> {
    this.log('Recoverable transport-start failure; rebuilding native engine');
    if (this.initialized) {
      await this.nativeAudio.cleanup();
      this.initialized = false;
    }
    this.assertSessionActive(session);
    await this.initialize();
    this.assertSessionActive(session);
    // A fresh native engine has zero latency compensation. Re-measure it for
    // the new route before reloading tracks, or the retried capture gate lands
    // at requested+0 frames and the overdub is silently misaligned on Android.
    if (session.capturesAudio) {
      await this.reapplyCaptureCompensation();
      this.assertSessionActive(session);
    }
    await this.nativeAudio.loadTracks(await this.prepareNativeTracks());
    this.assertSessionActive(session);
  }

  private async reapplyCaptureCompensation(): Promise<void> {
    const compensation = this.lastCaptureCompensation;
    if (!compensation) return;
    if (compensation.mode === 'captureOnly') {
      await this.nativeAudio.configureCaptureOnlyLatencyCompensation();
    } else {
      await this.nativeAudio.configureLatencyCompensation(compensation.adjustmentMs);
    }
  }

  /**
   * Start the native transport, retrying once after rebuilding the engine if
   * the start fails because the audio route changed or was interrupted.
   */
  private async startTransportWithRetry(
    session: TransportSession,
    start: () => Promise<void>
  ): Promise<void> {
    try {
      await start();
      this.assertSessionActive(session);
    } catch (error) {
      if (!this.isSessionActive(session) || !isRecoverableStartError(error)) {
        await this.cleanupFailedSession(session);
        throw error;
      }
      try {
        await this.rebuildEngineForSession(session);
        await start();
        this.assertSessionActive(session);
      } catch (retryError) {
        await this.cleanupFailedSession(session);
        throw retryError;
      }
    }
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
    if (this.isRecording) {
      throw new Error('Cannot start a new transport while capture is armed');
    }
    const capturesAudio = callbackTime !== undefined && onReachTime !== undefined;
    const session = this.beginSession(capturesAudio);

    try {
      await this.ensureInitialized();
      this.assertSessionActive(session);
      await this.nativeAudio.stop();
      this.assertSessionActive(session);
    } catch (error) {
      await this.cleanupFailedSession(session);
      throw error;
    }
    this.log(`playFrom: position=${position}s, callbackTime=${callbackTime}s`);

    const positionMs = Math.round(position * 1000);
    this.currentPositionMs = positionMs;
    this.callbackTriggered = false;
    if (capturesAudio) this.recordingStartPositionMs = 0;

    // If we need to start recording at a specific time, use playAndRecord
    if (capturesAudio) {
      const recordStartMs = Math.round(callbackTime * 1000);
      
      this.isPlaying = true;
      // Capture is armed before the punch callback. Track that lifecycle now so
      // Stop during preroll still drains and closes the native writer.
      this.isRecording = true;
      await this.startTransportWithRetry(session, () =>
        this.nativeAudio.playAndRecord(positionMs, recordStartMs, (actualStartMs) => {
          if (!this.isSessionActive(session)) {
            this.log(`Ignoring recording onset for cancelled session ${session.id}`);
            return;
          }
          this.log(`Recording started at ${actualStartMs}ms`);
          session.captureStarted = true;
          this.recordingStartPositionMs = actualStartMs;
          this.callbackTriggered = true;

          onReachTime();
        })
      );

      // Start position monitoring
      this.startPositionMonitoring(session);
    } else {
      // Just playback, no recording
      this.isPlaying = true;
      this.isRecording = false;

      await this.startTransportWithRetry(session, () =>
        this.nativeAudio.play(positionMs)
      );
      this.startPositionMonitoring(session);
    }
  }

  /**
   * Start position monitoring
   */
  private startPositionMonitoring(session: TransportSession): void {
    this.stopPositionMonitoring();

    const interval = setInterval(async () => {
      if (!this.isSessionActive(session) || (!this.isPlaying && !this.isRecording)) {
        clearInterval(interval);
        if (this.positionCheckInterval === interval) {
          this.positionCheckInterval = undefined;
        }
        return;
      }

      const positionMs = await this.nativeAudio.getCurrentPositionMs();
      if (!this.isSessionActive(session)) return;
      this.currentPositionMs = positionMs;
      const currentPos = positionMs / 1000;
      
      // Check if playback is complete
      const totalDuration = this.getTotalDuration();
      if (!this.isRecording && currentPos >= totalDuration) {
        this.log('Reached end of timeline');
        this.isPlaying = false;
        this.cancelActiveSession();
        clearInterval(interval);
        if (this.positionCheckInterval === interval) {
          this.positionCheckInterval = undefined;
        }
        try {
          await this.nativeAudio.stop();
        } catch (error) {
          this.log('Failed to stop completed transport:', error);
          await this.cleanup();
        }
        // Notify the UI so it can leave the "playing" state instead of wedging.
        this.onPlaybackComplete?.();
      }
    }, 50);
    this.positionCheckInterval = interval;
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
    const session = this.activeSession;
    if (!session) return;
    await this.ensureInitialized();
    this.assertSessionActive(session);
    this.log('pause');
    await this.nativeAudio.pause();
    this.assertSessionActive(session);
    this.isPlaying = false;
    this.stopPositionMonitoring();
  }

  /**
   * Resume playback
   */
  async play(): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      throw new Error('No paused audio transport to resume');
    }
    await this.ensureInitialized();
    this.assertSessionActive(session);
    this.log('play (resume)');
    await this.nativeAudio.resume();
    this.assertSessionActive(session);
    this.isPlaying = true;
    this.startPositionMonitoring(session);
  }

  /**
   * Stop playback and recording
   * Returns recording result if recording was active
   */
  async stop(): Promise<RecordingResult | null> {
    this.log('stop');
    const stoppedSession = this.cancelActiveSession();
    this.stopPositionMonitoring();
    
    const wasRecording = stoppedSession?.capturesAudio ?? this.isRecording;
    const wasWaitingForPunch = wasRecording
      && !(stoppedSession?.captureStarted ?? this.callbackTriggered);
    this.isPlaying = false;
    this.isRecording = false;
    this.callbackTriggered = false;

    // Native initialization and transport commands share the same engine.
    // Let an in-flight initialization settle before issuing the quiesce so a
    // Stop cannot be reordered ahead of initialization on either bridge.
    if (this.initializationPromise) {
      try {
        await this.initializationPromise;
      } catch {
        return null;
      }
    }

    // Stop the transport immediately so playback does not continue while a
    // long take is drained/resampled. Native engines deliberately preserve the
    // capture session until stopRecording() finalizes it. A transport-stop
    // rejection must NOT lose a WAV that stopRecording() then finalizes, so we
    // capture the stop error and still finalize the take.
    let transportStopError: unknown;
    try {
      await this.nativeAudio.stop();
    } catch (error) {
      transportStopError = error;
    }

    try {
      const result = wasRecording ? await this.nativeAudio.stopRecording() : null;
      if (result) {
        this.log('Recording stopped:', result);
        return result;
      }
      // No take was finalized. If the transport stop itself failed, surface it.
      if (transportStopError) throw transportStopError;
      return null;
    } catch (error) {
      // Stopping during preroll is a cancellation, not a failed take. Native
      // modules reject because no PCM has crossed the punch gate yet.
      if (wasWaitingForPunch && hasErrorCode(error, 'NO_RECORDING')) {
        this.log('Pending punch cancelled before microphone capture began');
        return null;
      }
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Seek to a position
   */
  async seekTo(position: number): Promise<void> {
    await this.ensureInitialized();
    this.log(`seekTo: ${position}s`);
    this.currentPositionMs = Math.round(position * 1000);
    await this.nativeAudio.seekTo(this.currentPositionMs);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    this.log('cleanup');
    this.cancelActiveSession();
    this.stopPositionMonitoring();
    this.callbackTriggered = false;
    this.isPlaying = false;
    this.isRecording = false;
    this.segments = [];

    if (this.initializationPromise) {
      try {
        await this.initializationPromise;
      } catch {
        return;
      }
    }
    
    if (this.initialized) {
      await this.nativeAudio.cleanup();
      this.initialized = false;
    }
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
    if (this.isRecording) {
      throw new Error('Cannot start a new transport while capture is armed');
    }
    const session = this.beginSession(true);

    let signalCaptureStarted: () => void = () => undefined;
    const captureStartedPromise = new Promise<void>(resolve => {
      signalCaptureStarted = resolve;
    });

    try {
      await this.ensureInitialized();
      this.assertSessionActive(session);
      this.log('startRecordingOnly');
      this.segments = [];
      await this.nativeAudio.loadTracks([]);
      this.assertSessionActive(session);
      await this.nativeAudio.configureCaptureOnlyLatencyCompensation();
      this.lastCaptureCompensation = { mode: 'captureOnly' };
      this.assertSessionActive(session);
      this.isRecording = true;
      this.isPlaying = false;
      this.callbackTriggered = false;
      this.recordingStartPositionMs = 0;
      this.currentPositionMs = 0;

      // Retry once after rebuilding the engine if the arm/start fails because
      // the route changed (a fresh engine re-runs capture-only compensation).
      await this.startTransportWithRetry(session, () =>
        this.nativeAudio.playAndRecord(0, 0, actualStartMs => {
          if (!this.isSessionActive(session)) {
            this.log(`Ignoring first microphone frame for cancelled session ${session.id}`);
            return;
          }
          session.captureStarted = true;
          this.callbackTriggered = true;
          this.recordingStartPositionMs = actualStartMs;
          signalCaptureStarted();
        })
      );

      if (!session.captureStarted) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            captureStartedPromise,
            session.cancelledPromise.then(() => {
              throw createSessionCancelledError();
            }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                reject(new Error('Timed out waiting for the first microphone frame'));
              }, 5_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      this.assertSessionActive(session);
      this.startPositionMonitoring(session);
    } catch (error) {
      await this.cleanupFailedSession(session);
      throw error;
    }
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
