import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPayloadKind } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  findActiveRun: vi.fn(),
  getPending: vi.fn(),
  rebindPending: vi.fn(),
  reply: vi.fn(),
  setActingUserOnSuccess: vi.fn(),
  submitAnswer: vi.fn(),
}));

vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  getPendingCommunicationRequestUserInput: mocks.getPending,
  rebindPendingCommunicationRequestUserInputRun: mocks.rebindPending,
  submitPendingCommunicationRequestUserInputAnswer: mocks.submitAnswer,
}));

vi.mock('@roomote/db/server', () => ({
  setTrustedRunActingUserOnSuccess: mocks.setActingUserOnSuccess,
}));

vi.mock('@roomote/sdk/server/communication', () => ({
  findActiveCommunicationTaskRun: mocks.findActiveRun,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));

import { buildDiscordRequestUserInputAnswerCallbackData } from '@roomote/communication';

import { tryHandleDiscordRequestUserInputCallback } from '../request-user-input.js';

const pendingRequest = {
  requestId: 'rui:session:turn:callid12',
  runId: 42,
  taskId: 'task-1',
  provider: 'discord' as const,
  conversationId: 'thread-1',
  questions: [
    {
      id: 'q1',
      header: 'Bump',
      question: 'What bump level should I cut?',
      isOther: false,
      isSecret: false,
      options: [{ label: 'minor', description: 'Recommended' }],
    },
  ],
  status: 'pending' as const,
  promptMessageId: 'prompt-1',
  currentQuestionIndex: 0,
  answers: {},
  createdAt: 123,
};

const channel = {
  channelId: 'thread-1',
  channelName: 'Task thread',
  channelType: 11,
  guildId: 'guild-1',
  parentChannelId: 'channel-1',
  isDirectMessage: false,
  isThread: true,
};

const interaction = {
  id: 'interaction-1',
  application_id: 'app-1',
  type: 3,
  token: 'token-1',
  channel_id: 'thread-1',
  user: { id: 'discord-user-1', username: 'matt' },
  data: { component_type: 2 },
};

function answerCustomId(): string {
  return buildDiscordRequestUserInputAnswerCallbackData({
    runId: 42,
    requestId: pendingRequest.requestId,
    questionIndex: 0,
    optionIndex: 0,
  });
}

describe('Discord request_user_input callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPending.mockResolvedValue(pendingRequest);
    mocks.rebindPending.mockResolvedValue(true);
    mocks.reply.mockResolvedValue({ messageId: 'response-1' });
    mocks.submitAnswer.mockResolvedValue(true);
    mocks.setActingUserOnSuccess.mockImplementation(
      async ({ operation }: { operation: () => Promise<boolean> }) =>
        operation(),
    );
  });

  it('rejects a structured answer unless the task owns the active reply target', async () => {
    mocks.findActiveRun.mockResolvedValue(undefined);
    const provider = { editMessage: vi.fn() } as never;

    await expect(
      tryHandleDiscordRequestUserInputCallback({
        provider,
        applicationId: 'app-1',
        channel,
        interaction: interaction as never,
        interactionDeferred: true,
        customId: answerCustomId(),
        userId: 'user-1',
      }),
    ).resolves.toBe(true);

    expect(mocks.findActiveRun).toHaveBeenCalledWith({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      taskId: 'task-1',
    });
    expect(mocks.setActingUserOnSuccess).not.toHaveBeenCalled();
    expect(mocks.submitAnswer).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'This prompt is no longer active.',
        ephemeral: true,
      }),
    );
  });

  it('accepts an authorized answer without rebinding the current run', async () => {
    mocks.findActiveRun.mockResolvedValue({ id: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await tryHandleDiscordRequestUserInputCallback({
      provider: { editMessage } as never,
      applicationId: 'app-1',
      channel,
      interaction: interaction as never,
      interactionDeferred: true,
      customId: answerCustomId(),
      userId: 'user-1',
    });

    expect(mocks.rebindPending).not.toHaveBeenCalled();
    expect(mocks.setActingUserOnSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 42, userId: 'user-1' }),
    );
    expect(mocks.submitAnswer).toHaveBeenCalledWith(
      'discord',
      'thread-1',
      pendingRequest,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'thread-1',
        messageId: 'prompt-1',
        buttons: [],
      }),
    );
  });

  it('atomically rebinds an authorized legacy prompt to its resumed run', async () => {
    mocks.findActiveRun.mockResolvedValue({
      id: 84,
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: 42 },
    });

    await tryHandleDiscordRequestUserInputCallback({
      provider: { editMessage: vi.fn().mockResolvedValue(undefined) } as never,
      applicationId: 'app-1',
      channel,
      interaction: interaction as never,
      interactionDeferred: true,
      customId: 'discord:rui:42:0:0:callid12',
      userId: 'user-1',
    });

    expect(mocks.rebindPending).toHaveBeenCalledWith({
      provider: 'discord',
      conversationId: 'thread-1',
      taskId: 'task-1',
      sourceRunId: 42,
      resumedRunId: 84,
    });
    expect(mocks.setActingUserOnSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 84, userId: 'user-1' }),
    );
    expect(mocks.submitAnswer).toHaveBeenCalledWith(
      'discord',
      'thread-1',
      { ...pendingRequest, runId: 84 },
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('does not rebind a later run without snapshot-resume lineage', async () => {
    mocks.findActiveRun.mockResolvedValue({ id: 84, payload: {} });

    await tryHandleDiscordRequestUserInputCallback({
      provider: { editMessage: vi.fn() } as never,
      applicationId: 'app-1',
      channel,
      interaction: interaction as never,
      interactionDeferred: true,
      customId: answerCustomId(),
      userId: 'user-1',
    });

    expect(mocks.rebindPending).not.toHaveBeenCalled();
    expect(mocks.submitAnswer).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'This prompt is no longer active.',
        ephemeral: true,
      }),
    );
  });
});
