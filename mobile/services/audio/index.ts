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

export {
  useDuetPlayback,
  type UseDuetPlaybackReturn,
} from './useDuetPlayback';

