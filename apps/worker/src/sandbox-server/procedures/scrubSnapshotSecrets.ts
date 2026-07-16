import { scrubSandboxSecretsBeforeSnapshot } from '../../commands/utils/scrub-sandbox-secrets';

import { publicProcedure } from '../trpc';

/**
 * Server-initiated variant of the pre-snapshot scrub. The snapshot queue
 * calls this best-effort before asking the compute provider for a filesystem
 * snapshot, covering trigger paths where the worker never runs its own
 * pre-snapshot scrub (for example recovery snapshots of a run that did not
 * reach the sleep handoff). The scrub is idempotent and everything it removes
 * is re-materialized from the dequeue/resume response at the next run start.
 */
export const scrubSnapshotSecrets = publicProcedure.mutation(
  async ({ ctx }) => {
    scrubSandboxSecretsBeforeSnapshot(ctx.harnessLogger ?? console);

    return { success: true };
  },
);
