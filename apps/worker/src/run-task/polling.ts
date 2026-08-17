import {
  TaskPayloadKind,
  getCommunicationProviderFromTaskPayload,
  getFastAgentParentFromPayload,
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

import { getLinearSessionIdFromResumePayload } from './linear-resume-payload';

import type { ListenerOptions, RunTaskState } from './types';
import {
  createCancelInterval,
  createCommunicationMessageInterval,
  createSlackMessageInterval,
  createLinearMessageInterval,
  createGitHubTokenRefreshInterval,
} from './polling/index';

export const startPolling = (options: ListenerOptions) => {
  const { taskRun, task, state, logger } = options;
  state.cancelInterval = createCancelInterval(options);

  // Prefer the task channel bindings from the dequeue/resume response; fall
  // back to payload-derived extraction for payloads that predate them.
  // Fast children are deliberately unbound from the Slack thread, but their
  // request_user_input answers are still queued by run ID, so they need the
  // same answer-polling loop to ever receive them.
  if (
    task?.slackThreadTs ||
    task?.slackChannelId ||
    getSlackThreadTsFromTaskPayload(taskRun.payload) ||
    getSlackChannelFromTaskPayload(taskRun.payload) ||
    getFastAgentParentFromPayload(taskRun.payload)
  ) {
    state.slackMessageInterval = createSlackMessageInterval(options);
  }

  const communicationProvider = getCommunicationProviderFromTaskPayload(
    taskRun.payload,
  );
  if (communicationProvider && communicationProvider !== 'slack') {
    state.communicationMessageIntervals ??= {};
    state.communicationMessageIntervals[communicationProvider] =
      createCommunicationMessageInterval({
        provider: communicationProvider,
        options,
      });
  }

  if (
    taskRun.payloadKind === TaskPayloadKind.LinearAgentSession ||
    (taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
      !!(
        task?.linearSessionId ??
        getLinearSessionIdFromResumePayload(taskRun.payload)
      ))
  ) {
    state.linearMessageInterval = createLinearMessageInterval(options);
  }

  state.githubTokenRefreshInterval = createGitHubTokenRefreshInterval({
    runId: taskRun.id,
    logger,
  });
};

export const stopPolling = async (state: RunTaskState) => {
  if (state.cancelInterval) {
    clearInterval(state.cancelInterval);
    state.cancelInterval = undefined;
  }

  if (state.slackMessageInterval) {
    clearInterval(state.slackMessageInterval);
    state.slackMessageInterval = undefined;
  }

  if (state.slackMessageCleanup) {
    await state.slackMessageCleanup();
    state.slackMessageCleanup = undefined;
  }

  if (state.communicationMessageIntervals) {
    for (const interval of Object.values(state.communicationMessageIntervals)) {
      if (interval) {
        clearInterval(interval);
      }
    }
    state.communicationMessageIntervals = undefined;
  }

  if (state.communicationMessageCleanups) {
    const cleanups = Object.values(state.communicationMessageCleanups);
    state.communicationMessageCleanups = undefined;
    await Promise.all(cleanups.map((cleanup) => cleanup?.()));
  }

  if (state.linearMessageInterval) {
    clearInterval(state.linearMessageInterval);
    state.linearMessageInterval = undefined;
  }

  if (state.linearMessageCleanup) {
    await state.linearMessageCleanup();
    state.linearMessageCleanup = undefined;
  }

  if (state.githubTokenRefreshInterval) {
    clearInterval(state.githubTokenRefreshInterval);
    state.githubTokenRefreshInterval = undefined;
  }
};
