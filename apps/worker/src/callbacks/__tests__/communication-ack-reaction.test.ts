import type { TaskRun } from '@roomote/sdk/client';
import { TaskPayloadKind } from '@roomote/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clearCommunicationAckReactionMock,
  publishFastAgentRequestUserInputMock,
  clearPendingSlackRequestUserInputMock,
} = vi.hoisted(() => ({
  clearCommunicationAckReactionMock: vi.fn(),
  publishFastAgentRequestUserInputMock: vi.fn(),
  clearPendingSlackRequestUserInputMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      clearCommunicationAckReaction: clearCommunicationAckReactionMock,
      publishFastAgentRequestUserInput: publishFastAgentRequestUserInputMock,
      clearPendingSlackRequestUserInput: clearPendingSlackRequestUserInputMock,
      publishCommunicationRequestUserInput: vi.fn(),
      clearPendingCommunicationRequestUserInput: vi.fn(),
    },
  },
}));

import { getCommunicationRunTaskCallbacks } from '../communication';

function makeTaskRun(
  payload: Record<string, unknown>,
  payloadKind: TaskPayloadKind = TaskPayloadKind.StandardTask,
): TaskRun {
  return {
    id: 42,
    taskId: 'task_abc',
    payloadKind,
    payload,
  } as TaskRun;
}

const pendDiscordIntake = {
  communicationProvider: 'discord',
  discordReactionChannelId: 'chan-1',
  discordReactionMessageId: 'msg-1',
  discordIntakeAckPending: true,
} as const;

describe('getCommunicationRunTaskCallbacks ack reaction cleanup', () => {
  beforeEach(() => {
    clearCommunicationAckReactionMock.mockReset();
    clearCommunicationAckReactionMock.mockResolvedValue({ cleared: true });
    publishFastAgentRequestUserInputMock.mockResolvedValue({
      published: true,
      messageTs: '101.001',
    });
    clearPendingSlackRequestUserInputMock.mockResolvedValue({ cleared: true });
  });

  it('publishes structured input from a Fast-delegated Slack child', async () => {
    const run = makeTaskRun({
      communicationProvider: 'slack',
      communicationChannelId: 'C123',
      communicationThreadId: '100.001',
      fastAgentParent: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        conversation: {
          surface: 'slack',
          workspaceId: 'T123',
          conversationId: '100.001',
          replyTarget: { channelId: 'C123', threadId: '100.001' },
        },
      },
    });
    const callbacks = getCommunicationRunTaskCallbacks(run);

    await callbacks.onMessage?.(
      run,
      run.taskId,
      {
        type: 'request_user_input',
        request: {
          requestId: 'request-1',
          questions: [
            {
              id: 'animal',
              prompt: 'Which animal?',
              options: [{ label: 'Hedgehog', value: 'hedgehog' }],
            },
          ],
        },
        ts: Date.now(),
      } as never,
      {},
    );

    expect(publishFastAgentRequestUserInputMock).toHaveBeenCalledWith({
      runId: 42,
      requestId: 'request-1',
      taskId: 'task_abc',
      questions: [
        expect.objectContaining({ id: 'animal', prompt: 'Which animal?' }),
      ],
    });
  });

  it('does not activate Slack structured input for a non-Fast task', () => {
    const callbacks = getCommunicationRunTaskCallbacks(
      makeTaskRun({
        communicationProvider: 'slack',
        communicationChannelId: 'C123',
        communicationThreadId: '100.001',
      }),
    );

    expect(callbacks.onMessage).toBeUndefined();
  });

  it('clears Discord intake eyes on start when intake pending is set', async () => {
    const run = makeTaskRun(pendDiscordIntake);
    const callbacks = getCommunicationRunTaskCallbacks(run);

    expect(callbacks.onStart).toBeTypeOf('function');
    await callbacks.onStart?.(run, 'task_abc', {});

    expect(clearCommunicationAckReactionMock).toHaveBeenCalledWith({
      runId: 42,
    });
  });

  it('clears Discord wake eyes on start for SnapshotResume runs with intake pending', async () => {
    const run = makeTaskRun(
      {
        communicationProvider: 'discord',
        discordReactionChannelId: 'chan-1',
        discordReactionMessageId: 'resume-msg',
        discordIntakeAckPending: true,
      },
      TaskPayloadKind.SnapshotResume,
    );
    const callbacks = getCommunicationRunTaskCallbacks(run);

    expect(callbacks.onStart).toBeTypeOf('function');
    await callbacks.onStart?.(run, 'task_abc', {});

    expect(clearCommunicationAckReactionMock).toHaveBeenCalledWith({
      runId: 42,
    });
  });

  it('does not register onStart for SnapshotResume without pending wake ack', () => {
    expect(
      getCommunicationRunTaskCallbacks(
        makeTaskRun(
          {
            communicationProvider: 'discord',
            communicationChannelId: 'chan-1',
            communicationMessageId: 'resume-msg',
          },
          TaskPayloadKind.SnapshotResume,
        ),
      ).onStart,
    ).toBeUndefined();
  });

  it('does not register onStart without a pending intake ack reaction', () => {
    expect(
      getCommunicationRunTaskCallbacks(
        makeTaskRun({
          communicationProvider: 'discord',
          discordReactionChannelId: 'chan-1',
          discordReactionMessageId: 'msg-1',
        }),
      ).onStart,
    ).toBeUndefined();
  });

  it('does not register onStart for telegram or teams', () => {
    expect(
      getCommunicationRunTaskCallbacks(
        makeTaskRun({ communicationProvider: 'telegram' }),
      ).onStart,
    ).toBeUndefined();
    expect(
      getCommunicationRunTaskCallbacks(
        makeTaskRun({ communicationProvider: 'teams' }),
      ).onStart,
    ).toBeUndefined();
  });

  it('swallows SDK failures during onStart cleanup', async () => {
    clearCommunicationAckReactionMock.mockRejectedValueOnce(
      new Error('network down'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const run = makeTaskRun(pendDiscordIntake);
    const callbacks = getCommunicationRunTaskCallbacks(run);

    await expect(
      callbacks.onStart?.(run, 'task_abc', {}),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
