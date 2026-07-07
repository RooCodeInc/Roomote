import { type DequeuedCloudJob, sdk } from '@roomote/sdk/client';

import { captureWorkerException } from '../monitoring/sentry';
import { runTask } from '../run-task';

import type { SetupMode } from './setup';
import { buildWorkspaceConfig, executeJob } from './utils';

export async function run({
  cloudJobId,
  setupMode,
  preserveGitState,
  keepaliveMsOverride,
}: {
  cloudJobId: number;
  setupMode: SetupMode;
  preserveGitState?: boolean;
  keepaliveMsOverride?: number;
}): Promise<boolean> {
  return executeJob<DequeuedCloudJob>({
    cloudJobId,
    setupMode,
    preserveGitState,
    fetchFn: async (id, workerReleaseMetadata) =>
      sdk.cloudJobs.dequeue(
        { cloudJobId: id, ...workerReleaseMetadata },
        {
          onBootstrapFailure: (error, cloudJob) => {
            captureWorkerException(error, {
              cloudJobId: cloudJob.id,
              stage: 'run.dequeueCloudJob.bootstrapFailure',
              taskId: cloudJob.taskId,
              taskType: cloudJob.type,
            });
          },
        },
      ),
    workspaceConfigFn: async ({
      cloudJob: {
        payload: { environmentId, repo, branch, sha, selectedRepositories },
      },
    }) =>
      buildWorkspaceConfig({
        environmentId,
        repo,
        branch,
        sha,
        selectedRepositories,
      }),
    runFn: async ({
      jobContext,
      workspace,
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
      repoLocalSkills,
      workspaceReadinessWarnings,
      cancelSignal,
      callbacks,
      context,
      logger,
      workerEnv,
    }) => {
      return runTask({
        ...jobContext,
        envVars: jobContext.envVars,
        workspacePath,
        prompt: jobContext.prompt,
        harnessInstructions: jobContext.harnessInstructions,
        usesSharedWorkspaceRoot,
        repoPaths,
        repoLocalSkills,
        workspaceReadinessWarnings,
        cancelSignal,
        orgAgentInstructions: jobContext.orgAgentInstructions,
        styleGuidance: jobContext.styleGuidance,
        agentInstructions:
          'environmentConfig' in workspace
            ? workspace.environmentConfig.agentInstructions
            : undefined,
        environmentConfig:
          'environmentConfig' in workspace
            ? workspace.environmentConfig
            : undefined,
        callbacks,
        context,
        logger,
        workerEnv,
        skipExternalSleepAction: setupMode === 'directDispatch',
        keepaliveMsOverride:
          keepaliveMsOverride ??
          (setupMode === 'directDispatch' ? 0 : undefined),
      });
    },
  });
}
