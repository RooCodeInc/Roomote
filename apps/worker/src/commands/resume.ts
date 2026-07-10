import {
  TaskPayloadKind,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';
import {
  type DequeuedResumeCloudJob as PreparedResumeCloudJob,
  sdk,
} from '@roomote/sdk/client';

import { captureWorkerException } from '../monitoring/sentry';
import { runTask } from '../run-task';
import { getLinearSessionIdFromResumePayload } from '../run-task/linear-resume-payload';
import { linearAgentCallbacks } from '../callbacks/linear-agent';
import { slackMentionCallbacks } from '../callbacks/slack-mention';

import { buildWorkspaceConfig, executeJob } from './utils';

export async function resume(cloudJobId: number): Promise<boolean> {
  return executeJob<PreparedResumeCloudJob>({
    cloudJobId,
    setupMode: 'full',
    preserveGitState: true,
    fetchFn: async (id, workerReleaseMetadata) =>
      sdk.cloudJobs.resume(
        { cloudJobId: id, ...workerReleaseMetadata },
        {
          onBootstrapFailure: (error, cloudJob) => {
            captureWorkerException(error, {
              cloudJobId: cloudJob.id,
              stage: 'resume.dequeueCloudJob.bootstrapFailure',
              taskId: cloudJob.taskId,
              taskType: cloudJob.payloadKind,
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
      callbacks: defaultCallbacks,
      context,
      logger,
      workerEnv,
    }) => {
      // Override callbacks for SnapshotResume jobs with integration metadata.
      // Prefer the task channel bindings from the resume response; fall back
      // to payload-derived extraction for payloads that predate them.
      const isLinearResume =
        jobContext.cloudJob.payloadKind === TaskPayloadKind.SnapshotResume &&
        Boolean(
          jobContext.task?.linearSessionId ??
          getLinearSessionIdFromResumePayload(jobContext.cloudJob.payload),
        );

      const isSlackResume =
        jobContext.cloudJob.payloadKind === TaskPayloadKind.SnapshotResume &&
        Boolean(
          jobContext.task?.slackThreadTs ??
          getSlackThreadTsFromTaskPayload(jobContext.cloudJob.payload),
        );

      const callbacks = isLinearResume
        ? linearAgentCallbacks
        : isSlackResume
          ? slackMentionCallbacks
          : defaultCallbacks;

      // Seed callback context for resumed integrations before runTask starts.
      // onStart still runs for resume jobs, but it should reuse the existing
      // harness session rather than overwrite it.
      if (isLinearResume || isSlackResume) {
        context.sessionId = jobContext.harnessSessionId;
        context.parentTaskId = jobContext.harnessSessionId;
        context.cloudTaskId = jobContext.cloudJob.taskId;
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
