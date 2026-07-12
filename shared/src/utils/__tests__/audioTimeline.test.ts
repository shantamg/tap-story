import {
  addTimelineStartTimes,
  getNextTimelineStartTimeMs,
} from '../audioTimeline';

describe('audioTimeline', () => {
  const durations = [10_001, 15_007, 10_003, 9_009, 4_321];

  it('starts the first two segments at zero and each later segment after the segment two positions back', () => {
    expect(addTimelineStartTimes(durations.map(durationMs => ({ durationMs })))).toEqual([
      { durationMs: 10_001, startTimeMs: 0 },
      { durationMs: 15_007, startTimeMs: 0 },
      { durationMs: 10_003, startTimeMs: 10_001 },
      { durationMs: 9_009, startTimeMs: 15_007 },
      { durationMs: 4_321, startTimeMs: 20_004 },
    ]);
  });

  it('calculates the next exact millisecond start without rounding', () => {
    const timeline = addTimelineStartTimes(
      durations.slice(0, 4).map(durationMs => ({ durationMs }))
    );

    expect(getNextTimelineStartTimeMs(timeline)).toBe(20_004);
  });

  it('does not substitute a sorted end-time rule when segment lengths vary', () => {
    const timeline = addTimelineStartTimes([
      { durationMs: 20_000 },
      { durationMs: 5_000 },
      { durationMs: 1_000 },
      { durationMs: 30_000 },
    ]);

    expect(timeline.map(segment => segment.startTimeMs)).toEqual([
      0,
      0,
      20_000,
      5_000,
    ]);
  });
});
