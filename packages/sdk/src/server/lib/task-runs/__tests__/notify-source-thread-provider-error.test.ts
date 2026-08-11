import { TaskPayloadKind, RunStatus } from '@roomote/types';
import type { Task, TaskRun } from '@roomote/db/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindFirstRun = vi.fn();
const mockFindFirstSlackInstallation = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisDel = vi.fn().mockResolvedValue(1);

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
        },
        slackInstallations: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstSlackInstallation(...args),
        },
      },
    },
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  }),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: vi.fn().mockReturnValue('https://example.com/task'),
}));

const mockSlackPostMessage = vi.fn().mockResolvedValue('ts-1');
const mockRemoveCancelButton = vi.fn().mockResolvedValue(true);
const mockUpdateMessage = vi.fn().mockResolvedValue(true);

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class MockSlackNotifier {
    postMessage = mockSlackPostMessage;
    removeCancelButton = mockRemoveCancelButton;
    updateMessage = mockUpdateMessage;
  },
}));

const mockDiscordPostMessage = vi.fn().mockResolvedValue({
  provider: 'discord',
  channelId: 'discord-channel',
  messageId: 'discord-message',
});
const mockCreateDiscordProvider = vi.fn();

vi.mock('../../discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: (
    ...args: unknown[]
  ) => mockCreateDiscordProvider(...args),
}));

const mockTeamsPostMessage = vi.fn().mockResolvedValue({
  provider: 'teams',
  channelId: 'teams-conversation',
  messageId: 'teams-activity',
});
const mockCreateTeamsProvider = vi.fn();

vi.mock('../../teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: (
    ...args: unknown[]
  ) => mockCreateTeamsProvider(...args),
}));

const mockTelegramPostMessage = vi.fn().mockResolvedValue({
  provider: 'telegram',
  channelId: '12345',
  messageId: '678',
});
const mockCreateTelegramProvider = vi.fn();

vi.mock('../../telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials: (
    ...args: unknown[]
  ) => mockCreateTelegramProvider(...args),
}));

const mockResolveSlackTaskRunRouting = vi.fn();

vi.mock('../slack-task-run-routing', () => ({
  resolveSlackTaskRunRouting: (...args: unknown[]) =>
    mockResolveSlackTaskRunRouting(...args),
}));

import { maybeNotifySourceThreadOfTerminalProviderError } from '../notify-source-thread-provider-error';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROVIDER_ERROR =
  'The provider returned an error: Our servers are currently overloaded. Please try again later.';

function payload(extra: Record<string, unknown>): TaskRun['payload'] {
  return { repo: 'owner/repo', ...extra } as unknown as TaskRun['payload'];
}

const discordPayload = payload({
  communicationProvider: 'discord',
  communicationChannelId: 'discord-channel',
  communicationThreadId: 'discord-thread',
});

const discordRootPayload = payload({
  communicationProvider: 'discord',
  communicationChannelId: 'discord-channel',
});

const telegramPayload = payload({
  communicationProvider: 'telegram',
  communicationChannelId: '12345',
  communicationThreadId: '99',
});

const teamsPayload = payload({
  communicationProvider: 'teams',
  communicationChannelId: 'teams-conversation',
  communicationServiceUrl: 'https://smba.example.com',
  communicationMessageId: 'teams-root',
});

function makeRun(
  overrides: Partial<TaskRun> = {},
  taskOverrides: Partial<Task> = {},
): TaskRun & { task: Task } {
  const task = {
    id: 'task-1',
    workflow: 'standard',
    surface: 'web',
    state: 'active',
    slackChannelId: null,
    slackThreadTs: null,
    title: 'Task 1',
    ...taskOverrides,
  } as Task;

  return {
    id: 7,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    status: RunStatus.Running,
    payload: { repo: 'owner/repo' },
    taskId: task.id,
    ...overrides,
    task,
  } as TaskRun & { task: Task };
}

function makeEnvelope({
  errorSummary = PROVIDER_ERROR,
  ts = 1_700_000_000_000,
  location = 'metadata',
}: {
  errorSummary?: string | null;
  ts?: number;
  location?: 'metadata' | 'payload' | 'none';
} = {}) {
  const detail =
    errorSummary === null
      ? undefined
      : { terminalProviderError: { errorSummary } };

  return {
    ts,
    eventType: 'assistant_message',
    role: 'assistant',
    contentBlocks: [{ type: 'text', text: errorSummary ?? 'hello' }],
    metadata: {
      sessionId: 'session-1',
      ...(location === 'metadata' ? detail : {}),
    },
    payload: {
      sessionId: 'session-1',
      ...(location === 'payload' ? detail : {}),
    },
    // Cast: the helper only reads ts/metadata/payload off the envelope.
  } as unknown as Parameters<
    typeof maybeNotifySourceThreadOfTerminalProviderError
  >[0]['envelope'];
}

function notify(envelope: ReturnType<typeof makeEnvelope>): Promise<void> {
  return maybeNotifySourceThreadOfTerminalProviderError({
    runId: 7,
    taskId: 'task-1',
    envelope,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('maybeNotifySourceThreadOfTerminalProviderError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockSlackPostMessage.mockResolvedValue('ts-1');
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
      teamId: 'T1',
      isActive: true,
    });
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '111.222',
      route: { kind: 'task', webPath: null },
    });
    mockCreateDiscordProvider.mockResolvedValue({
      postMessage: mockDiscordPostMessage,
    });
    mockCreateTeamsProvider.mockResolvedValue({
      postMessage: mockTeamsPostMessage,
    });
    mockCreateTelegramProvider.mockResolvedValue({
      postMessage: mockTelegramPostMessage,
    });
  });

  it('posts the provider error into the originating Slack thread', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );

    await notify(makeEnvelope());

    expect(mockSlackPostMessage).toHaveBeenCalledTimes(1);
    const [call] = mockSlackPostMessage.mock.calls;
    expect(call?.[0]).toMatchObject({
      channel: 'C123',
      thread_ts: '111.222',
    });
    expect(call?.[0].text).toContain('provider error');
    expect(call?.[0].text).toContain(
      'Our servers are currently overloaded. Please try again later.',
    );
  });

  it('leaves the Slack started message and its Cancel button alone', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );

    await notify(makeEnvelope());

    // The task is still alive and resumable, so its controls must stay usable.
    expect(mockRemoveCancelButton).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  it('posts into the originating Discord thread', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ payload: discordPayload }));

    await notify(makeEnvelope());

    expect(mockDiscordPostMessage).toHaveBeenCalledTimes(1);
    expect(mockDiscordPostMessage.mock.calls[0]?.[0]).toMatchObject({
      channelId: 'discord-channel',
      threadId: 'discord-thread',
      textFormat: 'markdown',
    });
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
  });

  it('posts into the originating Telegram topic', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ payload: telegramPayload }));

    await notify(makeEnvelope());

    expect(mockTelegramPostMessage).toHaveBeenCalledTimes(1);
    expect(mockTelegramPostMessage.mock.calls[0]?.[0]).toMatchObject({
      channelId: '12345',
      threadId: '99',
      textFormat: 'markdown',
    });
  });

  it('posts into the originating Teams conversation', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ payload: teamsPayload }));

    await notify(makeEnvelope());

    expect(mockTeamsPostMessage).toHaveBeenCalledTimes(1);
    expect(mockTeamsPostMessage.mock.calls[0]?.[0]).toMatchObject({
      channelId: 'teams-conversation',
      serviceUrl: 'https://smba.example.com',
      replyToMessageId: 'teams-root',
      textFormat: 'markdown',
    });
  });

  it('reads the provider error from the envelope payload too', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun({ payload: discordRootPayload }),
    );

    await notify(makeEnvelope({ location: 'payload' }));

    expect(mockDiscordPostMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores ordinary assistant messages', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());

    await notify(makeEnvelope({ location: 'none' }));

    expect(mockFindFirstRun).not.toHaveBeenCalled();
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-provider runtime error', 'spawn timeout'],
    [
      'an error carrying a URL',
      'The provider returned an error: see https://example.com/status',
    ],
    [
      'an error carrying a credential',
      'The provider returned an error: api_key=sk-secret rejected',
    ],
  ])('does not echo %s into the thread', async (_label, errorSummary) => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );

    await notify(makeEnvelope({ errorSummary }));

    expect(mockSlackPostMessage).not.toHaveBeenCalled();
  });

  it('reports regardless of run status so a live or sleeping task still speaks up', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        {
          status: RunStatus.Idle,
          payloadKind: TaskPayloadKind.SlackAppMention,
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );

    await notify(makeEnvelope());

    expect(mockSlackPostMessage).toHaveBeenCalledTimes(1);
  });

  it('skips tasks with no chat surface to report into', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ payload: payload({}) }));

    await notify(makeEnvelope());

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
  });

  it('posts at most once per failed turn', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );
    mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await notify(makeEnvelope());
    await notify(makeEnvelope());

    expect(mockSlackPostMessage).toHaveBeenCalledTimes(1);
  });

  it('claims per envelope timestamp so a later failed turn still reports', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );

    await notify(makeEnvelope({ ts: 1 }));
    await notify(makeEnvelope({ ts: 2 }));

    expect(mockSlackPostMessage).toHaveBeenCalledTimes(2);
    expect(mockRedisSet.mock.calls[0]?.[0]).toBe('turn-provider-error:7:1');
    expect(mockRedisSet.mock.calls[1]?.[0]).toBe('turn-provider-error:7:2');
  });

  it('skips when the run no longer exists', async () => {
    mockFindFirstRun.mockResolvedValue(undefined);

    await notify(makeEnvelope());

    expect(mockSlackPostMessage).not.toHaveBeenCalled();
  });

  it('skips when Slack has no active installation', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun(
        { payloadKind: TaskPayloadKind.SlackAppMention },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      ),
    );
    mockFindFirstSlackInstallation.mockResolvedValue(undefined);

    await notify(makeEnvelope());

    expect(mockSlackPostMessage).not.toHaveBeenCalled();
  });

  it('skips when the provider bot credentials are missing', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun({ payload: discordRootPayload }),
    );
    mockCreateDiscordProvider.mockResolvedValue(null);

    await notify(makeEnvelope());

    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
  });

  it('never throws when chat delivery fails', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun({ payload: discordRootPayload }),
    );
    mockDiscordPostMessage.mockRejectedValue(new Error('discord is down'));

    await expect(notify(makeEnvelope())).resolves.toBeUndefined();
  });

  describe('when nothing was actually delivered', () => {
    it('releases the claim when Slack rejects the reply', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun(
          { payloadKind: TaskPayloadKind.SlackAppMention },
          { slackChannelId: 'C123', slackThreadTs: '111.222' },
        ),
      );
      // Slack logs and returns no timestamp on failure instead of throwing.
      mockSlackPostMessage.mockResolvedValue(undefined);

      await notify(makeEnvelope({ ts: 5 }));

      expect(mockRedisDel).toHaveBeenCalledWith('turn-provider-error:7:5');
    });

    it('releases the claim when the provider adapter throws', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun({ payload: discordRootPayload }),
      );
      mockDiscordPostMessage.mockRejectedValue(new Error('discord is down'));

      await notify(makeEnvelope({ ts: 6 }));

      expect(mockRedisDel).toHaveBeenCalledWith('turn-provider-error:7:6');
    });

    it('releases the claim when provider credentials are missing', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun({ payload: discordRootPayload }),
      );
      mockCreateDiscordProvider.mockResolvedValue(null);

      await notify(makeEnvelope({ ts: 8 }));

      expect(mockRedisDel).toHaveBeenCalledWith('turn-provider-error:7:8');
    });

    it('lets a retry of the same envelope report after a failed delivery', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun(
          { payloadKind: TaskPayloadKind.SlackAppMention },
          { slackChannelId: 'C123', slackThreadTs: '111.222' },
        ),
      );
      mockSlackPostMessage.mockResolvedValueOnce(undefined);

      await notify(makeEnvelope({ ts: 9 }));
      await notify(makeEnvelope({ ts: 9 }));

      expect(mockSlackPostMessage).toHaveBeenCalledTimes(2);
    });

    it('does not throw when releasing the claim fails', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun({ payload: discordRootPayload }),
      );
      mockDiscordPostMessage.mockRejectedValue(new Error('discord is down'));
      mockRedisDel.mockRejectedValue(new Error('redis is down'));

      // The claim stays until its TTL, but message persistence must not break.
      await expect(notify(makeEnvelope({ ts: 10 }))).resolves.toBeUndefined();
    });

    it('keeps the claim after a successful delivery', async () => {
      mockFindFirstRun.mockResolvedValue(
        makeRun(
          { payloadKind: TaskPayloadKind.SlackAppMention },
          { slackChannelId: 'C123', slackThreadTs: '111.222' },
        ),
      );

      await notify(makeEnvelope());

      expect(mockRedisDel).not.toHaveBeenCalled();
    });
  });
});
