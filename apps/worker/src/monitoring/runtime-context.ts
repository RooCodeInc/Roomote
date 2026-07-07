export type WorkerRuntimeContext = Record<
  string,
  string | number | boolean | null | undefined
>;

let workerRuntimeContext: WorkerRuntimeContext | undefined;

function sanitizeWorkerRuntimeContext(
  context?: WorkerRuntimeContext,
): WorkerRuntimeContext | undefined {
  if (!context) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function getWorkerRuntimeContext(): WorkerRuntimeContext | undefined {
  return workerRuntimeContext ? { ...workerRuntimeContext } : undefined;
}

export function setWorkerRuntimeContext(context?: WorkerRuntimeContext): void {
  workerRuntimeContext = sanitizeWorkerRuntimeContext(context);
}

export function clearWorkerRuntimeContext(): void {
  workerRuntimeContext = undefined;
}
