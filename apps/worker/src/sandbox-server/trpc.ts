import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import type {
  AuthTokenContext,
  RunTokenContext,
  CodingHarness,
} from '@roomote/types';

// This import makes @trpc/client types available for declaration emit.
// Without it, TypeScript cannot name the Observable types used by subscriptions.
import '@trpc/client';

import type { HarnessLogger } from '../logging';
import type { WorkerEnv } from '../env';
import type {
  ActorMismatchPolicy,
  PrepareActorScopedTurnResult,
} from '../run-task/prepare-actor-scoped-turn';
import type { Harness } from './lib/harness';
import type { HarnessManager } from './lib/harness-manager';

export const DEFAULT_COMMAND_TIMEOUT = 300_000;

export interface Context {
  workingDirectory: string;
  harnessLogger?: HarnessLogger;
  harness: Harness;
  harnessManager?: HarnessManager;
  auth: AuthTokenContext | RunTokenContext | null;

  /** Task run ID for the current worker session. */
  runId?: number;

  /** Stable task ID from the task run (maps to tasks.id). */
  taskRunTaskId?: string;

  /** Path to the Slack reply satisfaction state file for Slack-originated jobs. */
  slackReplySatisfactionStateFile?: string;

  /** Effective coding harness for the current worker session. */
  codingHarness?: CodingHarness;

  /** Mutable worker environment state for live reloads. */
  workerEnv?: WorkerEnv;

  /**
   * Refresh actor-scoped integrations before delivering the next turn.
   * Returns `false` when the turn must not be delivered (default `block`
   * mismatch policy: the API's trusted pre-delivery actor sync did not put
   * the server actor on this sender).
   */
  prepareActorScopedTurn?: (
    targetUserId?: string,
    options?: {
      allowMcpReconnect?: boolean;
      deferReconnectUntilTurnBoundary?: boolean;
      onMismatch?: ActorMismatchPolicy;
    },
  ) => Promise<PrepareActorScopedTurnResult>;
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
