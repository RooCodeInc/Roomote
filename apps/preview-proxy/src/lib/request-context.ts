import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  traceparent: string;
  host?: string;
  method?: string;
  path?: string;
  taskId?: string;
  runId?: number;
  upstreamTarget?: string;
  outcome?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function setRequestContext(updates: Partial<RequestContext>): void {
  const context = requestContextStorage.getStore();
  if (context) {
    Object.assign(context, updates);
  }
}

export function runWithRequestContext<T>(
  initialContext: RequestContext,
  fn: () => T,
): T {
  return requestContextStorage.run(initialContext, fn);
}
