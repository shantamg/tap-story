// API request/response types

export interface StartRecordingRequest {
  // No parent - starting a new audio thread
}

export interface StartRecordingResponse {
  nodeId: string;
  uploadUrl: string;
}

export interface ReplyRequest {
  parentId: string;
  audio: Buffer | Blob;
}

export interface ReplyResponse {
  nodeId: string;
  audioUrl: string;
  durationMs: number;
  startTimeMs: number;
}

export interface GetNodeRequest {
  nodeId: string;
}

export interface GetNodeResponse {
  id: string;
  audioUrl: string;
  parentId: string | null;
  durationMs: number;
  startTimeMs: number;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
