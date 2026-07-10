// Deliberate subprocess terminations (reconnects, restarts, teardown) must
// not be certified as unexpected exits: they would pollute the death-
// certificate signal and page Sentry on every routine restart. Callers that
// kill an OpenCode subprocess on purpose mark it here first; the exit
// certification checks the mark before recording anything.
const expectedExits = new WeakSet<object>();

export function markExpectedSubprocessExit(subprocess: object): void {
  expectedExits.add(subprocess);
}

export function isExpectedSubprocessExit(subprocess: object): boolean {
  return expectedExits.has(subprocess);
}
