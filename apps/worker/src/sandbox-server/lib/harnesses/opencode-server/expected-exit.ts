// Deliberate subprocess terminations (reconnects, restarts, teardown) must
// not be certified as unexpected exits: they would pollute the death-
// certificate signal and page Sentry on every routine restart. Callers that
// kill an OpenCode subprocess on purpose mark it here first; the exit
// certification checks the mark before recording anything.
const expectedExits = new WeakSet<object>();

/**
 * Marks the subprocess as deliberately terminated — but only while it is
 * still alive. A process that already exited died on its own: the teardown
 * that follows a crash-induced disconnect must not retroactively suppress
 * the very certificate the crash should produce.
 */
export function markExpectedSubprocessExitIfAlive(subprocess: {
  exitCode: number | null;
  killed: boolean;
}): boolean {
  if (subprocess.exitCode !== null || subprocess.killed) {
    return false;
  }

  expectedExits.add(subprocess);
  return true;
}

export function isExpectedSubprocessExit(subprocess: object): boolean {
  return expectedExits.has(subprocess);
}
