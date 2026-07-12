interface TimelineNode {
  durationMs: number;
  startTimeMs: number;
}

/**
 * A root and its direct reply start together. Deeper replies begin at the
 * exact persisted end of their grandparent (two positions back in the chain).
 */
export function getReplyStartTimeMs(grandparent: TimelineNode | null): number {
  return grandparent ? grandparent.startTimeMs + grandparent.durationMs : 0;
}
