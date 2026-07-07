/**
 * Log a handler error with a consistent format.
 */
export function logHandlerError(handlerName: string, error: unknown): void {
  console.error(
    `[${handlerName}] Error:`,
    error instanceof Error ? error.message : String(error),
  );
}
