import { getCassetteControlAvailability } from '../CassettePlayerControls';

describe('cassette control availability', () => {
  it('allows only Stop while a synchronized recording is waiting for its punch point', () => {
    expect(getCassetteControlAvailability({
      isLoading: false,
      isDownloadingAudio: false,
      hasAudio: true,
      isRecording: false,
      isWaitingToRecord: true,
    })).toEqual({
      playDisabled: true,
      recordDisabled: true,
      seekDisabled: true,
      stopDisabled: false,
    });
  });
});
