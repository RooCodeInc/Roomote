import { TRPCError } from '@trpc/server';

import { releaseCredentialWriteBarrier } from '../../lib/credential-write-barrier';
import { refreshGitHubToken } from '../../run-task/polling/github-token-refresh';

import { applyDeploymentEnvVarsReload } from './reloadDeploymentEnvVars';
import { publicProcedure } from '../trpc';

/**
 * Recover a sandbox that survived an abandoned snapshot attempt. The
 * pre-snapshot scrub removed on-disk credential material and engaged the
 * credential write barrier; if the provider snapshot then terminally fails
 * while the sandbox keeps running, the snapshot queue calls this so the
 * still-live task can keep working: release the barrier, re-materialize the
 * source-control token files, and rewrite the sandbox env from the
 * deployment's current env vars.
 *
 * Harness-managed credential files (e.g. the OpenCode auth file) are not
 * rewritten here: the running harness already holds its credentials in
 * memory, and any new run start re-materializes them from the dequeue
 * response.
 */
export const restoreScrubbedCredentials = publicProcedure.mutation(
  async ({ ctx }) => {
    if (!ctx.runId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Task run context is required',
      });
    }

    const { runId, workerEnv, harness } = ctx;
    const logger = ctx.harnessLogger ?? console;

    releaseCredentialWriteBarrier();

    const failedSteps: string[] = [];

    // Writes the token env files and refreshed token/credential files.
    const tokenRefresh = await refreshGitHubToken({ runId, logger });

    if (!tokenRefresh.source) {
      failedSteps.push('refresh source-control token files');
    }

    if (workerEnv) {
      try {
        await applyDeploymentEnvVarsReload({ runId, workerEnv, harness });
      } catch (error) {
        logger.warn(
          `[restoreScrubbedCredentials] Failed to reload deployment env vars: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failedSteps.push('reload deployment env vars');
      }
    } else {
      failedSteps.push('reload deployment env vars (worker env unavailable)');
    }

    if (failedSteps.length > 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Credential restore failed to ${failedSteps.join('; ')}`,
      });
    }

    return { success: true };
  },
);
