/**
 * Audio Services - Main exports for track player functionality
 */
export {
  setupTrackPlayer,
  destroyTrackPlayer,
  isTrackPlayerSetup,
  resetTrackPlayerSetup,
  LATENCY_OFFSET_MS,
} from './trackPlayerSetup';

export { playbackService } from './playbackService';

export {
  DuetTrackPlayer,
  type DuetSegment,
  type PlaybackState,
} from './DuetTrackPlayer';

// Native duet player for synchronized audio
export {
  NativeDuetPlayer,
  createNativeDuetPlayer,
  type PlaybackStateType,
} from './NativeDuetPlayer';

export {
  useDuetPlayback,
  type UseDuetPlaybackReturn,
} from './useDuetPlayback';

// Native audio module for synchronized playback/recording
export {
  TapStoryNativeAudio,
  getTapStoryAudio,
  useTapStoryAudio,
  type TrackInfo,
  type RecordingResult,
  type PositionUpdateEvent,
  type RecordingStartedEvent,
} from './TapStoryNativeAudio';

// Simplified native audio wrapper
export {
  TapStoryAudioEngine,
  isNativeModuleAvailable,
  initialize as initializeNativeAudio,
  loadTracks as loadNativeTracks,
  play as nativePlay,
  playAndRecord as nativePlayAndRecord,
  getCurrentPositionMs as getNativePositionMs,
  stop as nativeStop,
  stopRecording as nativeStopRecording,
  cleanup as nativeCleanup,
  type AudioTrackInfo,
  type RecordingResult as NativeRecordingResult,
  type OnRecordingStartedCallback,
} from './TapStoryAudio';

