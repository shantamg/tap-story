export interface PendingAudioSegment {
  id: string;
  audioUrl: string;
  localUri: string;
  durationMs: number;
  startTimeMs: number;
  duration: number;
  startTime: number;
  parentId: string | null;
}

interface CreatePendingAudioSegmentInput {
  id: string;
  recordingUri: string;
  durationMs: number;
  startTimeMs: number;
  parentId: string | null;
}

/** Build the optimistic timeline node used while its upload is in flight. */
export function createPendingAudioSegment({
  id,
  recordingUri,
  durationMs,
  startTimeMs,
  parentId,
}: CreatePendingAudioSegmentInput): PendingAudioSegment {
  return {
    id,
    audioUrl: '',
    localUri: recordingUri,
    durationMs,
    startTimeMs,
    duration: durationMs / 1000,
    startTime: startTimeMs / 1000,
    parentId,
  };
}
