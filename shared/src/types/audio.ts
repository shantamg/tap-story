// Core audio types

export interface AudioNode {
  id: string;
  audioUrl: string;
  parentId: string | null;
  duration: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudioMetadata {
  duration: number;
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
  duration: number;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  key: string;
}

export interface SaveAudioRequest {
  key: string;
  duration: number;
  parentId: string | null;
}
