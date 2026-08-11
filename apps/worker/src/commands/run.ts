import { type DequeuedTaskRun, sdk } from '@roomote/sdk/client';

import { captureWorkerException } from '../monitoring/sentry';
import { runTask } from '../run-task';

import type { SetupMode } from './setup';
import { buildWorkspaceConfig, executeTaskRun } from './utils';

export async function run({
  runId,
  setupMode,
  preserveGitState,
  keepaliveMsOverride,
}: {
  runId: number;
  setupMode: SetupMode;
  preserveGitState?: boolean;
  keepaliveMsOverride?: number;
}): Promise<boolean> {
  return executeTaskRun<DequeuedTaskRun>({
    runId,
    setupMode,
    preserveGitState,
    fetchFn: async (id, workerReleaseMetadata) =>
      sdk.taskRuns.dequeue(
        { runId: id, ...workerReleaseMetadata },
        {
          onBootstrapFailure: (error, taskRun) => {
            captureWorkerException(error, {
              runId: taskRun.id,
              stage: 'run.dequeueTaskRun.bootstrapFailure',
              taskId: taskRun.taskId,
              taskType: taskRun.payloadKind,
            });
          },
        },
      ),
    workspaceConfigFn: async ({
      taskRun: {
        payload: { environmentId, repo, branch, sha, selectedRepositories },
        resolvedWorkspaceSpec,
      },
    }) =>
      buildWorkspaceConfig({
        environmentId,
        environmentConfig:
          resolvedWorkspaceSpec?.environmentId === environmentId
            ? resolvedWorkspaceSpec?.config
            : undefined,
        repo,
        branch,
        sha,
        selectedRepositories,
      }),
    runFn: async ({
      jobContext,
      userEnvVars,
      workspace,
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
      repoLocalSkills,
      workspaceReadinessWarnings,
      backgroundEnvironmentSetup,
      cancelSignal,
      callbacks,
      context,
      logger,
      workerEnv,
    }) => {
      return runTask({
        ...jobContext,
        envVars: jobContext.envVars,
        userEnvVars,
        workspacePath,
        prompt: jobContext.prompt,
        harnessInstructions: jobContext.harnessInstructions,
        // Task-level launch context from the dequeue response. Fresh
        // dispatches with kind 'unknown' map to plan-repo-implementation via
        // getInitialWorkflowPhase.
        requestedWorkKind: jobContext.requestedWorkKind,
        task: jobContext.task,
        usesSharedWorkspaceRoot,
        repoPaths,
        repoLocalSkills,
        workspaceReadinessWarnings,
        backgroundEnvironmentSetup,
        cancelSignal,
        orgAgentInstructions: jobContext.orgAgentInstructions,
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
