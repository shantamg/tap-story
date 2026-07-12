interface AudioInteractionState {
  isLoading: boolean;
  isDownloadingAudio?: boolean;
  downloadingSegmentCount?: number;
  processingSegmentCount: number;
  isRecording: boolean;
  isWaitingToRecord: boolean;
}

export function isAudioInteractionLocked({
  isLoading,
  isDownloadingAudio = false,
  downloadingSegmentCount = 0,
  processingSegmentCount,
  isRecording,
  isWaitingToRecord,
}: AudioInteractionState): boolean {
  return isLoading
    || isDownloadingAudio
    || downloadingSegmentCount > 0
    || processingSegmentCount > 0
    || isRecording
    || isWaitingToRecord;
}
