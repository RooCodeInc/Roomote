import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { createContext } from '@/trpc/init';
import {
  buildAuthServerTiming,
  buildHandlerServerTiming,
  describeRequestProcedures,
  logRequestTiming,
  withResponseCompletionTiming,
} from '@/trpc/request-timing';
import { appRouter as router } from '@/trpc/routers/_app';

export const runtime = 'nodejs';
// Fast session turns continue with after() and use a five-minute recovery
// deadline, so leave enough room to persist their terminal state.
export const maxDuration = 800;

const handler = async (req: Request) => {
  // Taken before anything else in the handler so the delta against the
  // client-observed duration is attributable to us and not to our own setup.
  const handlerStartedAt = performance.now();
  let authMs: number | null = null;

  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router,
    createContext: async () => {
      const contextStartedAt = performance.now();

      try {
        return await createContext();
      } finally {
        authMs = performance.now() - contextStartedAt;
      }
    },
    // Runs once the context exists but (with `httpBatchStreamLink`) before any
    // procedure has resolved, so only the auth phase can be reported here.
    responseMeta: () => {
      const authTiming = buildAuthServerTiming(authMs);

      return authTiming ? { headers: { 'server-timing': authTiming } } : {};
    },
  });

  const handlerMs = performance.now() - handlerStartedAt;

  try {
    // Still ahead of the headers going out, so this reaches the client.
    response.headers.append(
      'server-timing',
      buildHandlerServerTiming(handlerMs),
    );
  } catch {
    // Immutable headers are not worth failing a request over.
  }

  const url = new URL(req.url);
  const { procedures, batch } = describeRequestProcedures(url);

  return withResponseCompletionTiming(response, () => {
    logRequestTiming({
      path: url.pathname,
      procedures,
      batch,
      authMs,
      handlerMs,
      totalMs: performance.now() - handlerStartedAt,
      status: response.status,
    });
  });
};

export { handler as GET, handler as POST };
