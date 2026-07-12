export interface TimelineSegmentMs {
  durationMs: number;
  startTimeMs: number;
}

/**
 * Return the planned start of the next segment in Tap Story's alternating
 * two-track timeline. The first two segments start together at zero. Every
 * later segment starts at the exact end of the segment two positions back.
 */
export function getNextTimelineStartTimeMs(
  segments: readonly TimelineSegmentMs[]
): number {
  if (segments.length < 2) {
    return 0;
  }

  const segmentTwoPositionsBack = segments[segments.length - 2];
  return segmentTwoPositionsBack.startTimeMs + segmentTwoPositionsBack.durationMs;
}

/**
 * Add planned start times to an ordered chain without converting through
 * seconds. Existing object fields are preserved.
 */
export function addTimelineStartTimes<T extends { durationMs: number }>(
  segments: readonly T[]
): Array<T & { startTimeMs: number }> {
  const timeline: Array<T & { startTimeMs: number }> = [];

  for (const segment of segments) {
    timeline.push({
      ...segment,
      startTimeMs: getNextTimelineStartTimeMs(timeline),
    });
  }

  return timeline;
}
