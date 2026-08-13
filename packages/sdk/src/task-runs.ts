import { RunStatus } from '@roomote/types';

import {
  type AppRouterInput,
  type AppRouterOutput,
  client,
  workerHeartbeatClient,
} from './client';
import { hasBootstrapFailureSignal } from './bootstrap-failure-signal';

export type TaskRun = NonNullable<AppRouterOutput['taskRuns']['findFirstById']>;

export type DequeuedTaskRun = NonNullable<
  AppRouterOutput['taskRuns']['dequeue']
>;

export type DequeuedResumeTaskRun = NonNullable<
  AppRouterOutput['taskRuns']['resume']
>;

export interface SyncActingUserIdOptions {
  runId: AppRouterInput['taskRuns']['findFirstById'];
  /** The sender the caller wants the upcoming turn to run as. */
  newUserId: string;
  /**
   * The actor the worker last prepared locally (git author, mounted
   * integrations). Omit when unknown; a match then reports `updated` so the
   * worker refreshes its local state from the server value.
   */
  lastKnownUserId?: string | null;
}

export type SyncActingUserIdResult =
  | 'updated'
  | 'unchanged'
  | 'not-found'
  | 'mismatch';

export interface SyncActingUserIdOutcome {
  result: SyncActingUserIdResult;
  /**
   * The server-authoritative acting user for the run. Undefined only for
   * `not-found`.
   */
  actingUserId?: string | null;
}

export interface TaskRunBootstrapOptions {
  onBootstrapFailure?: (error: Error, taskRun: TaskRun) => void;
}

export interface TaskRunRequestOptions {
  signal?: AbortSignal;
}

function isImmediateBootstrapFailure(
  taskRun: TaskRun,
): taskRun is TaskRun & { error: string } {
  return (
    taskRun.status === RunStatus.Canceled &&
    taskRun.startedAt == null &&
    typeof taskRun.error === 'string' &&
    taskRun.error.length > 0 &&
    hasBootstrapFailureSignal(taskRun.artifacts)
  );
}

async function notifyOnBootstrapFailure(
  runId: number,
  onBootstrapFailure?: (error: Error, taskRun: TaskRun) => void,
): Promise<void> {
  if (!onBootstrapFailure) {
    return;
  }

  const taskRun = await findFirstById(runId);

  if (taskRun && isImmediateBootstrapFailure(taskRun)) {
    onBootstrapFailure(new Error(taskRun.error), taskRun);
  }
}

export const findFirstById = (
  runId: AppRouterInput['taskRuns']['findFirstById'],
) => client.taskRuns.findFirstById.query(runId);

export type TaskRunRuntimeState = NonNullable<
  AppRouterOutput['taskRuns']['findRuntimeStateById']
>;

/**
 * Narrow status snapshot for polling loops. Prefer this over `findFirstById`
 * anywhere that polls on an interval: it skips the large columns (payload,
 * prompt, result) that make full-row reads expensive under load.
 */
export const findRuntimeStateById = (
  runId: AppRouterInput['taskRuns']['findRuntimeStateById'],
) => client.taskRuns.findRuntimeStateById.query(runId);

export const update = (options: AppRouterInput['taskRuns']['update']) =>
  client.taskRuns.update.mutate(options);

export const updateRuntimeState = (
  options: AppRouterInput['taskRuns']['updateRuntimeState'],
) => client.taskRuns.updateRuntimeState.mutate(options);

export const touchTaskRunHeartbeat = (
  options: AppRouterInput['taskRuns']['touchTaskRunHeartbeat'],
  requestOptions?: TaskRunRequestOptions,
) =>
  workerHeartbeatClient.taskRuns.touchTaskRunHeartbeat.mutate(
    options,
    requestOptions,
  );

export const stampMilestone = (
  options: AppRouterInput['taskRuns']['stampMilestone'],
) => client.taskRuns.stampMilestone.mutate(options);

export const updateEnvironmentSetup = (
  options: AppRouterInput['taskRuns']['updateEnvironmentSetup'],
) => client.taskRuns.updateEnvironmentSetup.mutate(options);

export const getGoal = (options: AppRouterInput['taskRuns']['getGoal']) =>
  client.taskRuns.getGoal.query(options);

export const claimGoalContinuation = (
  options: AppRouterInput['taskRuns']['claimGoalContinuation'],
) => client.taskRuns.claimGoalContinuation.mutate(options);

export const releaseGoalContinuation = (
  options: AppRouterInput['taskRuns']['releaseGoalContinuation'],
) => client.taskRuns.releaseGoalContinuation.mutate(options);

/**
 * Reconcile the worker's local actor state against the server-authoritative
 * `task_runs.actingUserId` before delivering a turn.
 *
 * `actingUserId` feeds actor-scoped credential resolution, so it is writable
 * ONLY by trusted server-side actors (web steer, pre-delivery follow-up sync,
 * pre-queue webhook sync). TaskRun-scoped run tokens can no longer reassign it: a
 * compromised sandbox previously pointed `actingUserId` at an arbitrary user
 * via `taskRuns.update` and then read that user's decrypted credentials
 * through actor-scoped routes (a confused deputy). This function therefore
 * never writes — it reads the server value and tells the caller how the
 * upcoming turn relates to it:
 *
 * - `not-found`: the run row is gone; delivery must stop.
 * - `mismatch`: the server actor differs from the requested sender — no
 *   trusted writer switched the run to them. The caller must NOT run the
 *   sender's turn under the current credentials; it either blocks the turn
 *   or delivers it as the server actor (`actingUserId`), keeping credential
 *   resolution and attribution on the same identity.
 * - `updated`: the server actor matches the sender but differs from the
 *   worker's last-prepared actor — the caller must refresh actor-scoped
 *   integrations and the runtime git author from the server value.
 * - `unchanged`: server actor, sender, and local state all agree.
 */
export async function syncActingUserId(
  options: SyncActingUserIdOptions,
): Promise<SyncActingUserIdOutcome> {
  const { runId, newUserId, lastKnownUserId } = options;
  const taskRun = await findFirstById(runId);

  if (!taskRun) {
    return { result: 'not-found' };
  }

  const serverUserId = taskRun.actingUserId ?? null;

  if (serverUserId !== newUserId) {
    console.warn(
      `[syncActingUserId] Task run ${runId} acting user ` +
        `${serverUserId ?? 'none'} differs from requested ${newUserId}; ` +
        'not overriding (run tokens cannot reassign the acting user).',
    );
    return { result: 'mismatch', actingUserId: serverUserId };
  }

  if (lastKnownUserId !== undefined && serverUserId === lastKnownUserId) {
    return { result: 'unchanged', actingUserId: serverUserId };
  }

  return { result: 'updated', actingUserId: serverUserId };
}

export const enqueue = (options: AppRouterInput['taskRuns']['enqueue']) =>
  client.taskRuns.enqueue.mutate(options);

export async function dequeue(
  options: AppRouterInput['taskRuns']['dequeue'],
  { onBootstrapFailure }: TaskRunBootstrapOptions = {},
) {
  const result = await client.taskRuns.dequeue.mutate(options);

  if (!result) {
    await notifyOnBootstrapFailure(options.runId, onBootstrapFailure);
  }

  return result;
}

export async function resume(
  options: AppRouterInput['taskRuns']['resume'],
  { onBootstrapFailure }: TaskRunBootstrapOptions = {},
) {
  const result = await client.taskRuns.resume.mutate(options);

  if (!result) {
    await notifyOnBootstrapFailure(options.runId, onBootstrapFailure);
  }

  return result;
}

export const done = (options: AppRouterInput['taskRuns']['done']) =>
  client.taskRuns.done.mutate(options);

export const recordEvent = (
  options: AppRouterInput['taskRuns']['recordEvent'],
) => client.taskRuns.recordEvent.mutate(options);

export const recordMessageEnvelope = (
  options: AppRouterInput['taskRuns']['recordMessageEnvelope'],
) => client.taskRuns.recordMessageEnvelope.mutate(options);

export const claimShowWidgetFallbackDelivery = (
  options: AppRouterInput['taskRuns']['claimShowWidgetFallbackDelivery'],
) => client.taskRuns.claimShowWidgetFallbackDelivery.mutate(options);

export const releaseShowWidgetFallbackDelivery = (
  options: AppRouterInput['taskRuns']['releaseShowWidgetFallbackDelivery'],
) => client.taskRuns.releaseShowWidgetFallbackDelivery.mutate(options);

export const recordInferenceUsage = (
  options: AppRouterInput['taskRuns']['recordInferenceUsage'],
) => client.taskRuns.recordInferenceUsage.mutate(options);

export const recordComputeProviderUsage = (
  options: AppRouterInput['taskRuns']['recordComputeProviderUsage'],
) => client.taskRuns.recordComputeProviderUsage.mutate(options);

export const setHarnessSessionId = (
  options: AppRouterInput['taskRuns']['setHarnessSessionId'],
) => client.taskRuns.setHarnessSessionId.mutate(options);

export const getMessageSources = (
  options: AppRouterInput['taskRuns']['getMessageSources'],
) => client.taskRuns.getMessageSources.query(options);

export const getResolvedGitAuthor = (
  options: AppRouterInput['taskRuns']['getResolvedGitAuthor'],
) => client.taskRuns.getResolvedGitAuthor.query(options);

export const revertPrCommit = (
  options: AppRouterInput['taskRuns']['revertPrCommit'],
) => client.taskRuns.revertPrCommit.mutate(options);

export const createSnapshot = (
  options: AppRouterInput['taskRuns']['createSnapshot'],
) => client.taskRuns.createSnapshot.mutate(options);

export const enqueueSlackPrInactivityCheck = (
  options: AppRouterInput['taskRuns']['enqueueSlackPrInactivityCheck'],
) => client.taskRuns.enqueueSlackPrInactivityCheck.mutate(options);

export const getSlackMessages = (
  options: AppRouterInput['taskRuns']['getSlackMessages'],
) => client.taskRuns.getSlackMessages.query(options);

export const getCommunicationMessages = (
  options: AppRouterInput['taskRuns']['getCommunicationMessages'],
) => client.taskRuns.getCommunicationMessages.query(options);

export const queueSlackMessage = (
  options: AppRouterInput['taskRuns']['queueSlackMessage'],
) => client.taskRuns.queueSlackMessage.mutate(options);

export const queueCommunicationMessage = (
  options: AppRouterInput['taskRuns']['queueCommunicationMessage'],
) => client.taskRuns.queueCommunicationMessage.mutate(options);

export const getSlackStartedMessageData = (
  options: AppRouterInput['taskRuns']['getSlackStartedMessageData'],
) => client.taskRuns.getSlackStartedMessageData.query(options);

export const getSlackThreadFooterText = (
  options: AppRouterInput['taskRuns']['getSlackThreadFooterText'],
) => client.taskRuns.getSlackThreadFooterText.query(options);

export const recordOutboundSlackConversationMessage = (
  options: AppRouterInput['taskRuns']['recordOutboundSlackConversationMessage'],
) => client.taskRuns.recordOutboundSlackConversationMessage.mutate(options);

export const setPendingSlackRequestUserInput = (
  options: AppRouterInput['taskRuns']['setPendingSlackRequestUserInput'],
) => client.taskRuns.setPendingSlackRequestUserInput.mutate(options);

export const clearPendingSlackRequestUserInput = (
  options: AppRouterInput['taskRuns']['clearPendingSlackRequestUserInput'],
) => client.taskRuns.clearPendingSlackRequestUserInput.mutate(options);

export const getSlackRequestUserInputAnswers = (
  options: AppRouterInput['taskRuns']['getSlackRequestUserInputAnswers'],
) => client.taskRuns.getSlackRequestUserInputAnswers.query(options);

export const queueSlackRequestUserInputAnswer = (
  options: AppRouterInput['taskRuns']['queueSlackRequestUserInputAnswer'],
) => client.taskRuns.queueSlackRequestUserInputAnswer.mutate(options);

export const getLinearMessages = (
  options: AppRouterInput['taskRuns']['getLinearMessages'],
) => client.taskRuns.getLinearMessages.query(options);

export const queueLinearMessage = (
  options: AppRouterInput['taskRuns']['queueLinearMessage'],
) => client.taskRuns.queueLinearMessage.mutate(options);

export const setPendingLinearRequestUserInput = (
  options: AppRouterInput['taskRuns']['setPendingLinearRequestUserInput'],
) => client.taskRuns.setPendingLinearRequestUserInput.mutate(options);

export const clearPendingLinearRequestUserInput = (
  options: AppRouterInput['taskRuns']['clearPendingLinearRequestUserInput'],
) => client.taskRuns.clearPendingLinearRequestUserInput.mutate(options);

export const getLinearRequestUserInputAnswers = (
  options: AppRouterInput['taskRuns']['getLinearRequestUserInputAnswers'],
) => client.taskRuns.getLinearRequestUserInputAnswers.query(options);

export const queueLinearRequestUserInputAnswer = (
  options: AppRouterInput['taskRuns']['queueLinearRequestUserInputAnswer'],
) => client.taskRuns.queueLinearRequestUserInputAnswer.mutate(options);

export const publishDiscordRequestUserInput = (
  options: AppRouterInput['taskRuns']['publishDiscordRequestUserInput'],
) => client.taskRuns.publishDiscordRequestUserInput.mutate(options);

export const publishCommunicationRequestUserInput = (
  options: AppRouterInput['taskRuns']['publishCommunicationRequestUserInput'],
) => client.taskRuns.publishCommunicationRequestUserInput.mutate(options);

export const setPendingCommunicationRequestUserInput = (
  options: AppRouterInput['taskRuns']['setPendingCommunicationRequestUserInput'],
) => client.taskRuns.setPendingCommunicationRequestUserInput.mutate(options);

export const clearPendingCommunicationRequestUserInput = (
  options: AppRouterInput['taskRuns']['clearPendingCommunicationRequestUserInput'],
) => client.taskRuns.clearPendingCommunicationRequestUserInput.mutate(options);

export const clearCommunicationAckReaction = (
  options: AppRouterInput['taskRuns']['clearCommunicationAckReaction'],
) => client.taskRuns.clearCommunicationAckReaction.mutate(options);

export const getCommunicationRequestUserInputAnswers = (
  options: AppRouterInput['taskRuns']['getCommunicationRequestUserInputAnswers'],
) => client.taskRuns.getCommunicationRequestUserInputAnswers.query(options);

export const queueCommunicationRequestUserInputAnswer = (
  options: AppRouterInput['taskRuns']['queueCommunicationRequestUserInputAnswer'],
) => client.taskRuns.queueCommunicationRequestUserInputAnswer.mutate(options);

export const fetchSnapshotEnv = (
  options: AppRouterInput['taskRuns']['fetchSnapshotEnv'],
) => client.taskRuns.fetchSnapshotEnv.query(options);

export const getResolvedRuntimeEnvVars = (
  options: AppRouterInput['taskRuns']['getResolvedRuntimeEnvVars'],
) => client.taskRuns.getResolvedRuntimeEnvVars.query(options);

export const refreshGitHubTokenWithMetadata = (
  options: AppRouterInput['taskRuns']['refreshGitHubTokenWithMetadata'],
) => client.taskRuns.refreshGitHubTokenWithMetadata.mutate(options);
