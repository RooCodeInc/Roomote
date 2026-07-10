const MAX_RESOLVED_USER_INPUT_REQUEST_IDS = 256;

/**
 * Bounded oldest-evicted set of request ids that have already been answered
 * or abandoned. A late answer for one of these must be rejected rather than
 * fabricated into a replayed turn.
 */
export class OpenCodeResolvedUserInputTracker {
  private readonly ids = new Set<string>();

  constructor(
    private readonly maxIds: number = MAX_RESOLVED_USER_INPUT_REQUEST_IDS,
  ) {}

  record(requestId: string): void {
    // Re-insert to move to the end (most-recently-resolved) for eviction.
    this.ids.delete(requestId);
    this.ids.add(requestId);

    while (this.ids.size > this.maxIds) {
      const oldest = this.ids.values().next().value;

      if (oldest === undefined) {
        break;
      }

      this.ids.delete(oldest);
    }
  }

  has(requestId: string): boolean {
    return this.ids.has(requestId);
  }
}
