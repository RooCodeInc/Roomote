type PendingSessionBoardFlight = {
  column: string;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingFlights = new Map<string, PendingSessionBoardFlight>();
let activeBoardCount = 0;

export function registerSessionBoard() {
  activeBoardCount += 1;
  return () => {
    activeBoardCount = Math.max(0, activeBoardCount - 1);
  };
}

export function announceSessionBoardMove(
  sessionId: string,
  column: string,
): void {
  if (activeBoardCount === 0) return;

  const current = pendingFlights.get(sessionId);
  if (current) clearTimeout(current.timeout);

  const timeout = setTimeout(() => {
    if (pendingFlights.get(sessionId)?.timeout === timeout) {
      pendingFlights.delete(sessionId);
    }
  }, 2_000);
  pendingFlights.set(sessionId, { column, timeout });
}

export function consumeSessionBoardMove(
  sessionId: string,
  column: string,
): boolean {
  const pending = pendingFlights.get(sessionId);
  if (!pending || pending.column !== column) return false;

  clearTimeout(pending.timeout);
  pendingFlights.delete(sessionId);
  return true;
}
