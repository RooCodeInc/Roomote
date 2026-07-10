import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import {
  findTaskRunForAccess,
  findTaskRunByRunTokenClaims,
} from './lib/task-runs/find-task-run';

export interface Context {
  auth: AuthTokenContext | RunTokenContext | null;
  req?: Request;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Type guard to check if an auth context is a run token.
 */
export function isRunToken(
  auth: AuthTokenContext | RunTokenContext | null,
): auth is RunTokenContext {
  return auth !== null && 'runId' in auth;
}

/**
 * Requires authentication but allows any token type (auth or run).
 */
export const authenticatedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.auth) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource.',
    });
  }

  return opts.next({
    ctx: { ...ctx, auth: ctx.auth },
  });
});

/**
 * Blocks run tokens entirely. For endpoints workers should never access.
 */
export const userOnlyProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.auth) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource.',
    });
  }

  if (isRunToken(opts.ctx.auth)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This endpoint is not available to run tokens',
    });
  }

  return opts.next({
    ctx: { ...opts.ctx, auth: opts.ctx.auth as AuthTokenContext },
  });
});

/**
 * Procedure builder with runId enforcement. When a run token is used,
 * validates that the input's runId matches the token's runId.
 * Auth token callers are restricted to runs that exist in this deployment.
 *
 * @param schema - Zod schema for the input
 * @param extractRunId - Field name or extractor function to get runId from input
 */
export function runScoped<T extends z.ZodType>(
  schema: T,
  extractRunId: keyof z.infer<T> | ((input: z.infer<T>) => number),
) {
  return authenticatedProcedure
    .input(schema)
    .use(async ({ ctx, input, next }) => {
      const targetId = (
        typeof extractRunId === 'function'
          ? extractRunId(input)
          : (input as Record<string, unknown>)[extractRunId as string]
      ) as number;

      if (isRunToken(ctx.auth)) {
        const runId = ctx.auth.runId;

        if (targetId !== runId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot access resources from a different run',
          });
        }

        const scopedRun = await findTaskRunByRunTokenClaims(ctx.auth);

        if (!scopedRun) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot access resources from a different run',
          });
        }

        return next({ ctx: { ...ctx, runId } });
      }

      const scopedRun = await findTaskRunForAccess(targetId);

      if (!scopedRun) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources for an unknown run',
        });
      }

      return next({ ctx: { ...ctx, runId: targetId } });
    });
}

export const optionalAuthProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  return opts.next({ ctx: { ...ctx, auth: ctx.auth } });
});
