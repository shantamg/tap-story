// Core audio types

export interface AudioNode {
  id: string;
  audioUrl: string;
  parentId: string | null;
  duration: number;
  createdAt: Date;
  updatedAt: Date;
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
