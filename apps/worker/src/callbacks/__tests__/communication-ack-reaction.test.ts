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

function makeTaskRun(payload: Record<string, unknown>): TaskRun {
  return {
    id: 42,
    taskId: 'task_abc',
    payloadKind: TaskPayloadKind.StandardTask,
    payload,
  } as TaskRun;
}

describe('getCommunicationRunTaskCallbacks ack reaction cleanup', () => {
  beforeEach(() => {
    clearCommunicationAckReactionMock.mockReset();
    clearCommunicationAckReactionMock.mockResolvedValue({ cleared: true });
  });

  it('clears Discord intake eyes on start', async () => {
    const callbacks = getCommunicationRunTaskCallbacks(
      makeTaskRun({
        communicationProvider: 'discord',
        discordReactionChannelId: 'chan-1',
        discordReactionMessageId: 'msg-1',
      }),
    );

    expect(callbacks.onStart).toBeTypeOf('function');
    await callbacks.onStart?.(
      makeTaskRun({
        communicationProvider: 'discord',
        discordReactionChannelId: 'chan-1',
        discordReactionMessageId: 'msg-1',
      }),
      'task_abc',
      {},
    );

    expect(clearCommunicationAckReactionMock).toHaveBeenCalledWith({
      runId: 42,
    });
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

    const run = makeTaskRun({ communicationProvider: 'discord' });
    const callbacks = getCommunicationRunTaskCallbacks(run);

    await expect(
      callbacks.onStart?.(run, 'task_abc', {}),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
