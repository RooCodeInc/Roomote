import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import type {
  AuthTokenContext,
  JobTokenContext,
  CodingHarness,
} from '@roomote/types';

// This import makes @trpc/client types available for declaration emit.
// Without it, TypeScript cannot name the Observable types used by subscriptions.
import '@trpc/client';

import type { HarnessLogger } from '../logging';
import type { WorkerEnv } from '../env';
import type { Harness } from './lib/harness';
import type { HarnessManager } from './lib/harness-manager';

export const DEFAULT_COMMAND_TIMEOUT = 300_000;

export interface Context {
  workingDirectory: string;
  harnessLogger?: HarnessLogger;
  harness: Harness;
  harnessManager?: HarnessManager;
  auth: AuthTokenContext | JobTokenContext | null;

  /** Cloud job ID for the current worker session. */
  cloudJobId?: number;

  /** Stable task ID from the cloud job (maps to tasks.id). */
  cloudJobTaskId?: string;

  /** Path to the Slack reply satisfaction state file for Slack-originated jobs. */
  slackReplySatisfactionStateFile?: string;

  /** Effective coding harness for the current worker session. */
  codingHarness?: CodingHarness;

  /** Mutable worker environment state for live reloads. */
  workerEnv?: WorkerEnv;

  /** Refresh actor-scoped integrations before delivering the next turn. */
  prepareActorScopedTurn?: (
    targetUserId?: string,
    options?: {
      allowMcpReconnect?: boolean;
      deferReconnectUntilTurnBoundary?: boolean;
    },
  ) => Promise<boolean>;
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

// To re-enable logging middleware:
// const loggingMiddleware = t.middleware(async (opts) => {
//   const { next } = opts;
//   const result = await next();
//   return result;
// });
// export const publicProcedure = t.procedure.use(loggingMiddleware);

export const router = t.router;

export const publicProcedure = t.procedure;
