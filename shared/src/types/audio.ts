// Core audio types

export interface AudioNode {
  id: string;
  audioUrl: string;
  parentId: string | null;
  durationMs: number;
  startTimeMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: AudioFormat;
}

export enum AudioFormat {
  MP3 = 'mp3',
  M4A = 'm4a',
  WAV = 'wav',
  AAC = 'aac',
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface RecordingStatus {
  isRecording: boolean;
  isPaused: boolean;
  durationMs: number;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  key: string;
}

export interface SaveAudioRequest {
  key: string;
  durationMs: number;
  parentId: string | null;
}

export interface AudioChainSegment {
  id: string;
  durationMs: number;
  startTimeMs: number;
  parentId: string | null;
}

export interface AudioChainSummary {
  id: string;
  chainLength: number;
  totalDurationMs: number;
  createdAt: string;
  segments: AudioChainSegment[];
}
