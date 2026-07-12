import { createPendingAudioSegment } from '../pendingAudioSegment';

describe('createPendingAudioSegment', () => {
  it('keeps the native recording URI playable while its upload is pending', () => {
    expect(createPendingAudioSegment({
      id: 'temp-1',
      recordingUri: 'file:///tmp/native-recording.wav',
      durationMs: 5_960,
      startTimeMs: 0,
      parentId: null,
    })).toEqual({
      id: 'temp-1',
      audioUrl: '',
      localUri: 'file:///tmp/native-recording.wav',
      durationMs: 5_960,
      startTimeMs: 0,
      duration: 5.96,
      startTime: 0,
      parentId: null,
    });
  });
});
