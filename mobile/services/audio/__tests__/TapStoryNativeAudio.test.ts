import { getAdjustedLatencyCompensationMs } from '../TapStoryNativeAudio';

describe('latency fine-tuning', () => {
  it('applies signed adjustments around the automatic route estimate', () => {
    expect(getAdjustedLatencyCompensationMs(38, 12)).toBe(50);
    expect(getAdjustedLatencyCompensationMs(38, -12)).toBe(26);
  });

  it('bounds both the adjustment and the effective compensation', () => {
    expect(getAdjustedLatencyCompensationMs(20, -250)).toBe(1);
    expect(getAdjustedLatencyCompensationMs(900, 250)).toBe(1_000);
  });
});
