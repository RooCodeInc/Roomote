import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import { authorize } from '@/lib/server';
import {
  enrichTrpcClientErrorDetails,
  getTrpcClientErrorDetails,
  reportTrpcProcedureError,
  shouldReportTrpcProcedureError,
} from './error-logging';

// See:
// - https://trpc.io/docs/server/context
// - https://trpc.io/docs/server/authorization
export const createContext = async () => {
  const auth = await authorize();
  return { auth };
};

type Context = Awaited<ReturnType<typeof createContext>>;

// See:
// - https://trpc.io/docs/server/data-transformers
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ error, shape }) {
    const clientErrorDetails =
      getTrpcClientErrorDetails(error) ??
      getTrpcClientErrorDetails(error.cause ?? error);

    if (!clientErrorDetails) {
      return shape;
    }

    return {
      ...shape,
      message: clientErrorDetails.message,
      data: {
        ...shape.data,
        ...(clientErrorDetails.diagnostics
          ? { diagnostics: clientErrorDetails.diagnostics }
          : {}),
      },
    };
  },
});
const reportProcedureErrors = t.middleware(async (opts) => {
  try {
    return await opts.next();
  } catch (error) {
    if (shouldReportTrpcProcedureError(error)) {
      await enrichTrpcClientErrorDetails(error);
      reportTrpcProcedureError({
        error,
        path: opts.path,
        type: opts.type,
      });
    }

    throw error;
  }
});
const procedure = t.procedure.use(reportProcedureErrors);

export const createRouter = t.router;
export const publicProcedure = procedure;

export const protectedProcedure = procedure.use(async function isAuthed(opts) {
  const auth = opts.ctx.auth;

  if (!auth.success) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({ ctx: { auth } });
});
