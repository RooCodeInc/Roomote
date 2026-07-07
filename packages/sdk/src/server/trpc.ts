import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';

import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import {
  findCloudJobForAccess,
  findCloudJobByJobTokenClaims,
} from './lib/cloud-jobs/find-cloud-job';

export interface Context {
  auth: AuthTokenContext | JobTokenContext | null;
  req?: Request;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Type guard to check if an auth context is a job token.
 */
export function isJobToken(
  auth: AuthTokenContext | JobTokenContext | null,
): auth is JobTokenContext {
  return auth !== null && 'cloudJobId' in auth;
}

/**
 * Requires authentication but allows any token type (auth or job).
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
 * Blocks job tokens entirely. For endpoints workers should never access.
 */
export const nonJobProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.auth) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource.',
    });
  }

  if (isJobToken(opts.ctx.auth)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This endpoint is not available to job tokens',
    });
  }

  return opts.next({
    ctx: { ...opts.ctx, auth: opts.ctx.auth as AuthTokenContext },
  });
});

/**
 * Procedure builder with cloudJobId enforcement. When a job token is used,
 * validates that the input's cloudJobId matches the token's cloudJobId.
 * Auth token callers are restricted to jobs that exist in this deployment.
 *
 * @param schema - Zod schema for the input
 * @param extractJobId - Field name or extractor function to get cloudJobId from input
 */
export function jobScoped<T extends z.ZodType>(
  schema: T,
  extractJobId: keyof z.infer<T> | ((input: z.infer<T>) => number),
) {
  return authenticatedProcedure
    .input(schema)
    .use(async ({ ctx, input, next }) => {
      const targetId = (
        typeof extractJobId === 'function'
          ? extractJobId(input)
          : (input as Record<string, unknown>)[extractJobId as string]
      ) as number;

      if (isJobToken(ctx.auth)) {
        const cloudJobId = ctx.auth.cloudJobId;

        if (targetId !== cloudJobId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot access resources from a different job',
          });
        }

        const scopedJob = await findCloudJobByJobTokenClaims(ctx.auth);

        if (!scopedJob) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot access resources from a different job',
          });
        }

        return next({ ctx: { ...ctx, cloudJobId } });
      }

      const scopedJob = await findCloudJobForAccess(targetId);

      if (!scopedJob) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources for an unknown job',
        });
      }

      return next({ ctx: { ...ctx, cloudJobId: targetId } });
    });
}

export const optionalAuthProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  return opts.next({ ctx: { ...ctx, auth: ctx.auth } });
});
