type PendingFastSessionLaunch = {
  fastConversationId: string;
  text: string;
  images?: string[];
  createdAt: number;
};

const MAX_PENDING_LAUNCHES = 10;
const pendingLaunches = new Map<string, PendingFastSessionLaunch>();

export function stagePendingFastSessionLaunch(
  sessionId: string,
  launch: Omit<PendingFastSessionLaunch, 'createdAt'>,
): void {
  pendingLaunches.delete(sessionId);
  pendingLaunches.set(sessionId, { ...launch, createdAt: Date.now() });

  const oldestSessionId = pendingLaunches.keys().next().value;
  if (pendingLaunches.size > MAX_PENDING_LAUNCHES && oldestSessionId) {
    pendingLaunches.delete(oldestSessionId);
  }
}

export function getPendingFastSessionLaunch(
  sessionId: string,
): PendingFastSessionLaunch | undefined {
  return pendingLaunches.get(sessionId);
}

export function clearPendingFastSessionLaunch(sessionId: string): void {
  pendingLaunches.delete(sessionId);
}
