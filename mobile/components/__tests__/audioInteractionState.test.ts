import { isAudioInteractionLocked } from '../audioInteractionState';

describe('isAudioInteractionLocked', () => {
  it('locks timeline interaction while an optimistic segment is uploading', () => {
    expect(isAudioInteractionLocked({
      isLoading: false,
      processingSegmentCount: 1,
      isRecording: false,
      isWaitingToRecord: false,
    })).toBe(true);
  });

  it('allows timeline interaction for an idle finalized chain', () => {
    expect(isAudioInteractionLocked({
      isLoading: false,
      processingSegmentCount: 0,
      isRecording: false,
      isWaitingToRecord: false,
    })).toBe(false);
  });
});
