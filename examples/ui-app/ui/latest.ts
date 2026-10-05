/**
 * Latest-wins guard for overlapping async requests.
 *
 * Each request takes a ticket before it starts. When its response arrives it
 * applies only if no newer ticket has been issued since; otherwise it is
 * superseded and dropped. Without this, a slow older response (e.g. "grain")
 * can land after a newer one ("fruit") and revert the user's latest choice.
 */
export interface LatestGuard {
  /** Issue a ticket for a request that is about to start (supersedes all older ones). */
  next(): number;
  /** True iff `ticket` is still the newest issued. */
  isCurrent(ticket: number): boolean;
}

export function createLatestGuard(): LatestGuard {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (ticket) => ticket === seq,
  };
}
