/**
 * Latch that quiesces credential-file writers before a filesystem snapshot.
 * The pre-snapshot scrub engages the barrier and waits for in-flight writes
 * to drain; while engaged, writers (the source-control token refresh loop,
 * deployment env reloads) skip their file writes so they cannot
 * re-materialize credentials between the scrub and the provider snapshot.
 *
 * The barrier stays engaged for the normal snapshot lifecycle — the sandbox
 * is completed and torn down, or resumed from the snapshot with credentials
 * re-injected at run start. When a snapshot terminally fails and the sandbox
 * keeps running, the credential restore path releases the barrier so the
 * surviving task can refresh tokens and reload its environment again.
 */

let engaged = false;
const inFlightWrites = new Set<Promise<unknown>>();

export function isCredentialWriteBarrierEngaged(): boolean {
  return engaged;
}

/**
 * Engage the barrier and wait for already-started credential writes to
 * settle. New writes started after this call are skipped by
 * `runUnlessCredentialWriteBarrier`.
 */
export async function engageCredentialWriteBarrier(): Promise<void> {
  engaged = true;

  while (inFlightWrites.size > 0) {
    await Promise.allSettled([...inFlightWrites]);
  }
}

/**
 * Re-enable credential writes after a snapshot attempt is abandoned with the
 * sandbox still running.
 */
export function releaseCredentialWriteBarrier(): void {
  engaged = false;
}

/**
 * Run a credential write unless the barrier is engaged. Returns `null`
 * (without invoking `work`) when the write was skipped. While the returned
 * promise is pending, `engageCredentialWriteBarrier` waits for it.
 */
export async function runUnlessCredentialWriteBarrier<T>(
  work: () => Promise<T>,
): Promise<T | null> {
  if (engaged) {
    return null;
  }

  const write = work();
  inFlightWrites.add(write);

  try {
    return await write;
  } finally {
    inFlightWrites.delete(write);
  }
}

/** Test-only: reset module state between test cases. */
export function resetCredentialWriteBarrierForTesting(): void {
  engaged = false;
  inFlightWrites.clear();
}
