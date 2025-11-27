/**
 * TapStoryAudio - TypeScript wrapper for the native synchronized audio module
 * 
 * This module provides a clean API for synchronized audio playback and recording
 * using native modules (Android: AudioTrack/AudioRecord, iOS: AVAudioEngine).
 * 
 * Key features:
 * - Frame-accurate synchronization between playback and recording
 * - Hardware-level timestamps for precise sync
 * - Multi-track mixing with proper timing
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { TapStoryAudio: NativeTapStoryAudio } = NativeModules;

// Event emitter for native callbacks
const eventEmitter = NativeTapStoryAudio 
  ? new NativeEventEmitter(NativeTapStoryAudio)
  : null;

/**
 * Track to be loaded for playback
 */
export interface AudioTrackInfo {
  id: string;
  uri: string;
  startTimeMs: number;
}

/**
 * Result from a recording session
 */
export interface RecordingResult {
  uri: string;
  startTimeMs: number;
  durationMs: number;
}

/**
 * Callback when recording actually starts (for sync tracking)
 */
export type OnRecordingStartedCallback = (actualStartMs: number) => void;

// Keep track of listeners
let recordingStartedListener: any = null;
let currentOnRecordingStarted: OnRecordingStartedCallback | null = null;

/**
 * Check if the native module is available
 */
export function isNativeModuleAvailable(): boolean {
  return NativeTapStoryAudio != null;
}

/**
 * Initialize the audio engine
 * Must be called before any other operations
 */
export async function initialize(): Promise<void> {
  if (!NativeTapStoryAudio) {
    console.warn('[TapStoryAudio] Native module not available, falling back to expo-av');
    return;
  }
  
  console.log('[TapStoryAudio] Initializing native audio engine');
  await NativeTapStoryAudio.initialize();
  console.log('[TapStoryAudio] Native audio engine initialized');
}

/**
 * Load tracks for synchronized playback
 * 
 * @param tracks Array of tracks with id, uri, and startTimeMs
 */
export async function loadTracks(tracks: AudioTrackInfo[]): Promise<void> {
  if (!NativeTapStoryAudio) {
    console.warn('[TapStoryAudio] Native module not available');
    return;
  }
  
  console.log('[TapStoryAudio] Loading', tracks.length, 'tracks');
  await NativeTapStoryAudio.loadTracks(tracks);
}

/**
 * Start playback only (no recording)
 * 
 * @param playFromMs Position to start playback from in milliseconds
 */
export async function play(playFromMs: number): Promise<void> {
  if (!NativeTapStoryAudio) {
    console.warn('[TapStoryAudio] Native module not available');
    return;
  }
  
  console.log('[TapStoryAudio] Starting playback from', playFromMs, 'ms');
  await NativeTapStoryAudio.play(playFromMs);
}

/**
 * Start synchronized playback and recording
 * 
 * This is the key method for duet functionality. It:
 * 1. Starts playback from playFromMs
 * 2. When playback reaches recordStartMs, recording begins
 * 3. Calls onRecordingStarted with the exact time recording started
 * 
 * @param playFromMs Position to start playback from
 * @param recordStartMs Position at which recording should begin
 * @param onRecordingStarted Callback when recording actually starts
 */
export async function playAndRecord(
  playFromMs: number,
  recordStartMs: number,
  onRecordingStarted?: OnRecordingStartedCallback
): Promise<void> {
  if (!NativeTapStoryAudio) {
    console.warn('[TapStoryAudio] Native module not available');
    return;
  }
  
  console.log('[TapStoryAudio] Starting playback from', playFromMs, 'ms, recording at', recordStartMs, 'ms');
  
  // Set up event listener for recording started
  if (recordingStartedListener) {
    recordingStartedListener.remove();
    recordingStartedListener = null;
  }
  
  if (onRecordingStarted && eventEmitter) {
    currentOnRecordingStarted = onRecordingStarted;
    recordingStartedListener = eventEmitter.addListener(
      'onRecordingStarted',
      (event: { actualStartMs: number }) => {
        console.log('[TapStoryAudio] Recording started at', event.actualStartMs, 'ms');
        if (currentOnRecordingStarted) {
          currentOnRecordingStarted(event.actualStartMs);
        }
      }
    );
  }
  
  await NativeTapStoryAudio.playAndRecord(playFromMs, recordStartMs);
}

/**
 * Get current playback position with hardware-accurate timing
 * 
 * @returns Current position in milliseconds
 */
export async function getCurrentPositionMs(): Promise<number> {
  if (!NativeTapStoryAudio) {
    return 0;
  }
  
  return await NativeTapStoryAudio.getCurrentPositionMs();
}

/**
 * Stop playback
 */
export async function stop(): Promise<void> {
  if (!NativeTapStoryAudio) {
    return;
  }
  
  console.log('[TapStoryAudio] Stopping playback');
  await NativeTapStoryAudio.stop();
}

/**
 * Stop recording and get the recording result
 * 
 * @returns Recording result with uri, startTimeMs, and durationMs
 */
export async function stopRecording(): Promise<RecordingResult | null> {
  if (!NativeTapStoryAudio) {
    return null;
  }
  
  console.log('[TapStoryAudio] Stopping recording');
  
  // Clean up event listener
  if (recordingStartedListener) {
    recordingStartedListener.remove();
    recordingStartedListener = null;
  }
  currentOnRecordingStarted = null;
  
  const result = await NativeTapStoryAudio.stopRecording();
  
  if (result) {
    console.log('[TapStoryAudio] Recording result:', result);
    return result as RecordingResult;
  }
  
  return null;
}

/**
 * Cleanup and release resources
 * Call this when done with audio operations
 */
export async function cleanup(): Promise<void> {
  if (!NativeTapStoryAudio) {
    return;
  }
  
  console.log('[TapStoryAudio] Cleaning up');
  
  // Clean up event listener
  if (recordingStartedListener) {
    recordingStartedListener.remove();
    recordingStartedListener = null;
  }
  currentOnRecordingStarted = null;
  
  await NativeTapStoryAudio.cleanup();
}

/**
 * Convenience class for managing the audio engine lifecycle
 */
export class TapStoryAudioEngine {
  private initialized = false;
  private playing = false;
  private recording = false;
  
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    
    await initialize();
    this.initialized = true;
  }
  
  async loadTracks(tracks: AudioTrackInfo[]): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    await loadTracks(tracks);
  }
  
  async play(playFromMs: number): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    this.playing = true;
    await play(playFromMs);
  }
  
  async playAndRecord(
    playFromMs: number,
    recordStartMs: number,
    onRecordingStarted?: OnRecordingStartedCallback
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    this.playing = true;
    this.recording = true;
    await playAndRecord(playFromMs, recordStartMs, onRecordingStarted);
  }
  
  async getCurrentPositionMs(): Promise<number> {
    return getCurrentPositionMs();
  }
  
  async stop(): Promise<void> {
    this.playing = false;
    await stop();
  }
  
  async stopRecording(): Promise<RecordingResult | null> {
    this.recording = false;
    return stopRecording();
  }
  
  async cleanup(): Promise<void> {
    this.playing = false;
    this.recording = false;
    this.initialized = false;
    await cleanup();
  }
  
  isPlaying(): boolean {
    return this.playing;
  }
  
  isRecording(): boolean {
    return this.recording;
  }
  
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Default export for convenience
export default {
  isNativeModuleAvailable,
  initialize,
  loadTracks,
  play,
  playAndRecord,
  getCurrentPositionMs,
  stop,
  stopRecording,
  cleanup,
  TapStoryAudioEngine,
};

