import { CloudTaskStatus } from '@roomote/types';

import {
  type AppRouterInput,
  type AppRouterOutput,
  client,
  workerHeartbeatClient,
} from './client';
import { hasBootstrapFailureSignal } from './bootstrap-failure-signal';

export type CloudJob = NonNullable<
  AppRouterOutput['cloudJobs']['findFirstById']
>;

export type DequeuedCloudJob = NonNullable<
  AppRouterOutput['cloudJobs']['dequeue']
>;

export type DequeuedResumeCloudJob = NonNullable<
  AppRouterOutput['cloudJobs']['resume']
>;

export interface SyncActingUserIdOptions {
  cloudJobId: AppRouterInput['cloudJobs']['findFirstById'];
  newUserId: string;
}

export type SyncActingUserIdResult = 'updated' | 'unchanged' | 'not-found';

export interface CloudJobBootstrapOptions {
  onBootstrapFailure?: (error: Error, cloudJob: CloudJob) => void;
}

export interface CloudJobRequestOptions {
  signal?: AbortSignal;
}

function isImmediateBootstrapFailure(
  cloudJob: CloudJob,
): cloudJob is CloudJob & { error: string } {
  return (
    cloudJob.status === CloudTaskStatus.Canceled &&
    cloudJob.startedAt == null &&
    typeof cloudJob.error === 'string' &&
    cloudJob.error.length > 0 &&
    hasBootstrapFailureSignal(cloudJob.artifacts)
  );
}

async function notifyOnBootstrapFailure(
  cloudJobId: number,
  onBootstrapFailure?: (error: Error, cloudJob: CloudJob) => void,
): Promise<void> {
  if (!onBootstrapFailure) {
    return;
  }

  const cloudJob = await findFirstById(cloudJobId);

  if (cloudJob && isImmediateBootstrapFailure(cloudJob)) {
    onBootstrapFailure(new Error(cloudJob.error), cloudJob);
  }
}

export const findFirstById = (
  cloudJobId: AppRouterInput['cloudJobs']['findFirstById'],
) => client.cloudJobs.findFirstById.query(cloudJobId);

export type CloudJobRuntimeState = NonNullable<
  AppRouterOutput['cloudJobs']['findRuntimeStateById']
>;

/**
 * Narrow status snapshot for polling loops. Prefer this over `findFirstById`
 * anywhere that polls on an interval: it skips the large columns (payload,
 * prompt, result) that make full-row reads expensive under load.
 */
export const findRuntimeStateById = (
  cloudJobId: AppRouterInput['cloudJobs']['findRuntimeStateById'],
) => client.cloudJobs.findRuntimeStateById.query(cloudJobId);

export const update = (options: AppRouterInput['cloudJobs']['update']) =>
  client.cloudJobs.update.mutate(options);

export const updateRuntimeState = (
  options: AppRouterInput['cloudJobs']['updateRuntimeState'],
) => client.cloudJobs.updateRuntimeState.mutate(options);

export const touchCloudJobHeartbeat = (
  options: AppRouterInput['cloudJobs']['touchCloudJobHeartbeat'],
  requestOptions?: CloudJobRequestOptions,
) =>
  workerHeartbeatClient.cloudJobs.touchCloudJobHeartbeat.mutate(
    options,
    requestOptions,
  );

export const stampMilestone = (
  options: AppRouterInput['cloudJobs']['stampMilestone'],
) => client.cloudJobs.stampMilestone.mutate(options);

/**
 * Keep the cloud job's acting user aligned with the latest prompt sender.
 *
 * This is separate from `cloudJob.userId`, which identifies the job owner used
 * for job-token scoping. Integration MCP proxies read `actingUserId` when
 * choosing whose OAuth credentials to use for a running task, so callers
 * update it before prompt delivery instead of inferring it later from
 * asynchronously persisted `task_messages`.
 */
export async function syncActingUserId(
  options: SyncActingUserIdOptions,
): Promise<SyncActingUserIdResult> {
  const { cloudJobId, newUserId } = options;
  const cloudJob = await findFirstById(cloudJobId);

  if (!cloudJob) {
    return 'not-found';
  }

  if ((cloudJob.actingUserId ?? null) === newUserId) {
    return 'unchanged';
  }

  await update({ id: cloudJobId, actingUserId: newUserId });
  return 'updated';
}

export const enqueue = (options: AppRouterInput['cloudJobs']['enqueue']) =>
  client.cloudJobs.enqueue.mutate(options);

export async function dequeue(
  options: AppRouterInput['cloudJobs']['dequeue'],
  { onBootstrapFailure }: CloudJobBootstrapOptions = {},
) {
  const result = await client.cloudJobs.dequeue.mutate(options);

  if (!result) {
    await notifyOnBootstrapFailure(options.cloudJobId, onBootstrapFailure);
  }

  return result;
}

export async function resume(
  options: AppRouterInput['cloudJobs']['resume'],
  { onBootstrapFailure }: CloudJobBootstrapOptions = {},
) {
  const result = await client.cloudJobs.resume.mutate(options);

  if (!result) {
    await notifyOnBootstrapFailure(options.cloudJobId, onBootstrapFailure);
  }

  return result;
}

export const done = (options: AppRouterInput['cloudJobs']['done']) =>
  client.cloudJobs.done.mutate(options);

export const recordEvent = (
  options: AppRouterInput['cloudJobs']['recordEvent'],
) => client.cloudJobs.recordEvent.mutate(options);

export const recordMessageEnvelope = (
  options: AppRouterInput['cloudJobs']['recordMessageEnvelope'],
) => client.cloudJobs.recordMessageEnvelope.mutate(options);

export const recordInferenceUsage = (
  options: AppRouterInput['cloudJobs']['recordInferenceUsage'],
) => client.cloudJobs.recordInferenceUsage.mutate(options);

export const recordComputeProviderUsage = (
  options: AppRouterInput['cloudJobs']['recordComputeProviderUsage'],
) => client.cloudJobs.recordComputeProviderUsage.mutate(options);

export const setHarnessSessionId = (
  options: AppRouterInput['cloudJobs']['setHarnessSessionId'],
) => client.cloudJobs.setHarnessSessionId.mutate(options);

export const getMessageSources = (
  options: AppRouterInput['cloudJobs']['getMessageSources'],
) => client.cloudJobs.getMessageSources.query(options);

export const getResolvedGitAuthor = (
  options: AppRouterInput['cloudJobs']['getResolvedGitAuthor'],
) => client.cloudJobs.getResolvedGitAuthor.query(options);

export const revertPrCommit = (
  options: AppRouterInput['cloudJobs']['revertPrCommit'],
) => client.cloudJobs.revertPrCommit.mutate(options);

export const createSnapshot = (
  options: AppRouterInput['cloudJobs']['createSnapshot'],
) => client.cloudJobs.createSnapshot.mutate(options);

export const enqueueSlackPrInactivityCheck = (
  options: AppRouterInput['cloudJobs']['enqueueSlackPrInactivityCheck'],
) => client.cloudJobs.enqueueSlackPrInactivityCheck.mutate(options);

export const getSlackMessages = (
  options: AppRouterInput['cloudJobs']['getSlackMessages'],
) => client.cloudJobs.getSlackMessages.query(options);

export const getCommunicationMessages = (
  options: AppRouterInput['cloudJobs']['getCommunicationMessages'],
) => client.cloudJobs.getCommunicationMessages.query(options);

export const queueSlackMessage = (
  options: AppRouterInput['cloudJobs']['queueSlackMessage'],
) => client.cloudJobs.queueSlackMessage.mutate(options);

export const queueCommunicationMessage = (
  options: AppRouterInput['cloudJobs']['queueCommunicationMessage'],
) => client.cloudJobs.queueCommunicationMessage.mutate(options);

export const getSlackStartedMessageData = (
  options: AppRouterInput['cloudJobs']['getSlackStartedMessageData'],
) => client.cloudJobs.getSlackStartedMessageData.query(options);

export const getSlackThreadFooterText = (
  options: AppRouterInput['cloudJobs']['getSlackThreadFooterText'],
) => client.cloudJobs.getSlackThreadFooterText.query(options);

export const recordOutboundSlackConversationMessage = (
  options: AppRouterInput['cloudJobs']['recordOutboundSlackConversationMessage'],
) => client.cloudJobs.recordOutboundSlackConversationMessage.mutate(options);

export const setPendingSlackRequestUserInput = (
  options: AppRouterInput['cloudJobs']['setPendingSlackRequestUserInput'],
) => client.cloudJobs.setPendingSlackRequestUserInput.mutate(options);

export const clearPendingSlackRequestUserInput = (
  options: AppRouterInput['cloudJobs']['clearPendingSlackRequestUserInput'],
) => client.cloudJobs.clearPendingSlackRequestUserInput.mutate(options);

export const getSlackRequestUserInputAnswers = (
  options: AppRouterInput['cloudJobs']['getSlackRequestUserInputAnswers'],
) => client.cloudJobs.getSlackRequestUserInputAnswers.query(options);

export const queueSlackRequestUserInputAnswer = (
  options: AppRouterInput['cloudJobs']['queueSlackRequestUserInputAnswer'],
) => client.cloudJobs.queueSlackRequestUserInputAnswer.mutate(options);

export const getLinearMessages = (
  options: AppRouterInput['cloudJobs']['getLinearMessages'],
) => client.cloudJobs.getLinearMessages.query(options);

export const queueLinearMessage = (
  options: AppRouterInput['cloudJobs']['queueLinearMessage'],
) => client.cloudJobs.queueLinearMessage.mutate(options);

export const setPendingLinearRequestUserInput = (
  options: AppRouterInput['cloudJobs']['setPendingLinearRequestUserInput'],
) => client.cloudJobs.setPendingLinearRequestUserInput.mutate(options);

export const clearPendingLinearRequestUserInput = (
  options: AppRouterInput['cloudJobs']['clearPendingLinearRequestUserInput'],
) => client.cloudJobs.clearPendingLinearRequestUserInput.mutate(options);

export const getLinearRequestUserInputAnswers = (
  options: AppRouterInput['cloudJobs']['getLinearRequestUserInputAnswers'],
) => client.cloudJobs.getLinearRequestUserInputAnswers.query(options);

export const queueLinearRequestUserInputAnswer = (
  options: AppRouterInput['cloudJobs']['queueLinearRequestUserInputAnswer'],
) => client.cloudJobs.queueLinearRequestUserInputAnswer.mutate(options);

export const fetchSnapshotEnv = (
  options: AppRouterInput['cloudJobs']['fetchSnapshotEnv'],
) => client.cloudJobs.fetchSnapshotEnv.query(options);

export const getResolvedRuntimeEnvVars = (
  options: AppRouterInput['cloudJobs']['getResolvedRuntimeEnvVars'],
) => client.cloudJobs.getResolvedRuntimeEnvVars.query(options);

export const refreshGitHubTokenWithMetadata = (
  options: AppRouterInput['cloudJobs']['refreshGitHubTokenWithMetadata'],
) => client.cloudJobs.refreshGitHubTokenWithMetadata.mutate(options);
