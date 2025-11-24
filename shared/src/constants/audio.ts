import { AudioFormat } from '../types/audio';

// Maximum audio duration in seconds (5 minutes)
export const MAX_AUDIO_DURATION_SECONDS = 300;

// Allowed audio formats
export const ALLOWED_AUDIO_FORMATS: AudioFormat[] = [
  AudioFormat.MP3,
  AudioFormat.M4A,
  AudioFormat.WAV,
  AudioFormat.AAC,
];

// Default sample rate for audio processing
export const DEFAULT_SAMPLE_RATE = 44100;

// Default number of audio channels
export const DEFAULT_CHANNELS = 2;

// Maximum file size in bytes (50MB)
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
