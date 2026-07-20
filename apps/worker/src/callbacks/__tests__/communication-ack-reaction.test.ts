import type { TaskRun } from '@roomote/sdk/client';
import { TaskPayloadKind } from '@roomote/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearCommunicationAckReactionMock } = vi.hoisted(() => ({
  clearCommunicationAckReactionMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      clearCommunicationAckReaction: clearCommunicationAckReactionMock,
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

  it('does not register onStart for SnapshotResume Discord runs', () => {
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
