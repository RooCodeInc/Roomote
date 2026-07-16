/**
 * One-way latch that quiesces credential-file writers before a filesystem
 * snapshot. The pre-snapshot scrub engages the barrier and waits for in-flight
 * writes to drain; once engaged, later writers (the source-control token
 * refresh loop, deployment env reloads) skip their file writes so they cannot
 * re-materialize credentials between the scrub and the provider snapshot.
 *
 * The latch never releases: after a snapshot request the sandbox is either
 * completed and torn down or resumed from the snapshot with credentials
 * re-injected at run start, so no writer has a legitimate reason to run again
 * in this process.
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
