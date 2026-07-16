import { TRPCError } from '@trpc/server';

import { scrubSandboxSecretsBeforeSnapshot } from '../../commands/utils/scrub-sandbox-secrets';

import { publicProcedure } from '../trpc';

/**
 * Server-initiated variant of the pre-snapshot scrub. The snapshot queue
 * calls this best-effort before asking the compute provider for a filesystem
 * snapshot, covering trigger paths where the worker never runs its own
 * pre-snapshot scrub (for example recovery snapshots of a run that did not
 * reach the sleep handoff). The scrub is idempotent and everything it removes
 * is re-materialized from the dequeue/resume response at the next run start.
 *
 * Uses the task runtime home/env from the server context so harness
 * credential files under a task-scoped HOME are found, and reports partial
 * scrub failures as an error so the caller does not treat an incomplete
 * scrub as a completed one.
 */
export const scrubSnapshotSecrets = publicProcedure.mutation(
  async ({ ctx }) => {
    const { failedSteps } = await scrubSandboxSecretsBeforeSnapshot(
      ctx.harnessLogger ?? console,
      ctx.taskRuntime ?? {},
    );

    if (failedSteps.length > 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Pre-snapshot scrub failed to ${failedSteps.join('; ')}`,
      });
    }

    return { success: true };
  },
);
