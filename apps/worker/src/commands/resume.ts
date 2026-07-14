import {
  TaskPayloadKind,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';
import {
  type DequeuedResumeTaskRun as PreparedResumeTaskRun,
  sdk,
} from '@roomote/sdk/client';

import { captureWorkerException } from '../monitoring/sentry';
import { runTask } from '../run-task';
import { getLinearSessionIdFromResumePayload } from '../run-task/linear-resume-payload';
import { linearAgentCallbacks } from '../callbacks/linear-agent';
import { slackMentionCallbacks } from '../callbacks/slack-mention';

import { buildWorkspaceConfig, executeTaskRun } from './utils';

export async function resume(runId: number): Promise<boolean> {
  return executeTaskRun<PreparedResumeTaskRun>({
    runId,
    setupMode: 'full',
    preserveGitState: true,
    fetchFn: async (id, workerReleaseMetadata) =>
      sdk.taskRuns.resume(
        { runId: id, ...workerReleaseMetadata },
        {
          onBootstrapFailure: (error, taskRun) => {
            captureWorkerException(error, {
              runId: taskRun.id,
              stage: 'resume.dequeueTaskRun.bootstrapFailure',
              taskId: taskRun.taskId,
              taskType: taskRun.payloadKind,
            });
          },
        },
      ),
    workspaceConfigFn: async ({
      sourceEnvironmentId: environmentId,
      sourceRepo: repo,
      sourceSelectedRepositories: selectedRepositories,
    }) => buildWorkspaceConfig({ environmentId, repo, selectedRepositories }),
    runFn: async ({
      jobContext,
      workspace,
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
      repoLocalSkills,
      workspaceReadinessWarnings,
      backgroundEnvironmentSetup,
      callbacks: defaultCallbacks,
      context,
      logger,
      workerEnv,
    }) => {
      // Override callbacks for SnapshotResume runs with integration metadata.
      // Prefer the task channel bindings from the resume response; fall back
      // to payload-derived extraction for payloads that predate them.
      const isLinearResume =
        jobContext.taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
        Boolean(
          jobContext.task?.linearSessionId ??
          getLinearSessionIdFromResumePayload(jobContext.taskRun.payload),
        );

      const isSlackResume =
        jobContext.taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
        Boolean(
          jobContext.task?.slackThreadTs ??
          getSlackThreadTsFromTaskPayload(jobContext.taskRun.payload),
        );

      const callbacks = isLinearResume
        ? linearAgentCallbacks
        : isSlackResume
          ? slackMentionCallbacks
          : defaultCallbacks;

      // Seed callback context for resumed integrations before runTask starts.
      // onStart still runs for resume task runs, but it should reuse the existing
      // harness session rather than overwrite it.
      if ((isLinearResume || isSlackResume) && jobContext.harnessSessionId) {
        context.sessionId = jobContext.harnessSessionId;
        context.parentTaskId = jobContext.harnessSessionId;
        context.taskId = jobContext.taskRun.taskId;
      }

      return runTask({
        ...jobContext,
        envVars: jobContext.envVars,
        workspacePath,
        prompt: '',
        harnessInstructions: jobContext.harnessInstructions,
        requestedWorkKind: jobContext.requestedWorkKind,
        task: jobContext.task,
        usesSharedWorkspaceRoot,
        repoPaths,
        repoLocalSkills,
        workspaceReadinessWarnings,
        backgroundEnvironmentSetup,
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
        harnessSessionId: jobContext.harnessSessionId,
        workerEnv,
      });
    },
  });
}
