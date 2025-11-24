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
  duration: number;
}

export interface GetNodeRequest {
  nodeId: string;
}

export interface GetNodeResponse {
  id: string;
  audioUrl: string;
  parentId: string | null;
  duration: number;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
