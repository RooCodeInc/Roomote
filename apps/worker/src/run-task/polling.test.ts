import { TaskPayloadKind } from '@roomote/types';

import type { HarnessLogger } from '../logging';
import { startPolling } from './polling';
import type { ListenerOptions, RunTaskState } from './types';

const {
  mockCreateCancelInterval,
  mockCreateCommunicationMessageInterval,
  mockCreateSlackMessageInterval,
  mockCreateLinearMessageInterval,
  mockCreateGitHubTokenRefreshInterval,
} = vi.hoisted(() => ({
  mockCreateCancelInterval: vi.fn(),
  mockCreateCommunicationMessageInterval: vi.fn(),
  mockCreateSlackMessageInterval: vi.fn(),
  mockCreateLinearMessageInterval: vi.fn(),
  mockCreateGitHubTokenRefreshInterval: vi.fn(),
}));

vi.mock('./polling/index', () => ({
  createCancelInterval: mockCreateCancelInterval,
  createCommunicationMessageInterval: mockCreateCommunicationMessageInterval,
  createSlackMessageInterval: mockCreateSlackMessageInterval,
  createLinearMessageInterval: mockCreateLinearMessageInterval,
  createGitHubTokenRefreshInterval: mockCreateGitHubTokenRefreshInterval,
}));

function createLogger(): HarnessLogger {
  return {
    runId: 42,
    filePath: '/tmp/harness.log',
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createState(): RunTaskState {
  return {
    sessionId: 'task-1',
    lastMessageAt: undefined,
    lastActivityAt: undefined,
    taskFinishedAt: undefined,
    taskAbortedAt: undefined,
    clientDisconnectedAt: undefined,
    cancelTriggeredAt: undefined,
    lastErrorMessage: undefined,
    cancelInterval: undefined,
    slackMessageInterval: undefined,
    slackMessageCleanup: undefined,
    linearMessageInterval: undefined,
    githubTokenRefreshInterval: undefined,
  };
}

function createListenerOptions(
  taskRun: Partial<ListenerOptions['taskRun']>,
  task?: ListenerOptions['task'],
): ListenerOptions {
  return {
    taskRun: {
      id: 42,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {},
      ...taskRun,
    } as ListenerOptions['taskRun'],
    task,
    state: createState(),
    logger: createLogger(),
    workingDirectory: '/tmp/workspace',
    cancelTask: vi.fn(),
    sendPrompt: vi.fn<ListenerOptions['sendPrompt']>(async () => true),
    answerUserInputRequest: vi.fn<ListenerOptions['answerUserInputRequest']>(
      () => true,
    ),
    prepareActorScopedTurn: vi.fn(
      async (targetUserId?: string) =>
        ({ effectiveUserId: targetUserId ?? null }) as const,
    ),
  };
}

describe('startPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCreateCancelInterval.mockImplementation(() =>
      setInterval(() => {}, 1_000),
    );
    mockCreateCommunicationMessageInterval.mockImplementation(() =>
      setInterval(() => {}, 1_000),
    );
    mockCreateSlackMessageInterval.mockImplementation(() =>
      setInterval(() => {}, 1_000),
    );
    mockCreateLinearMessageInterval.mockImplementation(() =>
      setInterval(() => {}, 1_000),
    );
    mockCreateGitHubTokenRefreshInterval.mockImplementation(() =>
      setInterval(() => {}, 1_000),
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('starts Slack message polling for any Slack-linked task run', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.Scan,
      payload: {
        repo: 'owner/repo',
        description: 'Suggest follow-up tasks',
        thread_ts: '111.222',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).toHaveBeenCalledWith(options);
    expect(options.state.slackMessageInterval).toBeDefined();
  });

  it('starts Slack message polling for jobs with Slack channel metadata before a thread exists', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.Scan,
      payload: {
        repo: 'owner/repo',
        description: 'Suggest follow-up tasks',
        slackChannel: 'C123',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).toHaveBeenCalledWith(options);
    expect(options.state.slackMessageInterval).toBeDefined();
  });

  it('does not start Slack message polling without Slack thread or channel linkage', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.Scan,
      payload: {
        repo: 'owner/repo',
        description: 'Suggest follow-up tasks',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).not.toHaveBeenCalled();
    expect(options.state.slackMessageInterval).toBeUndefined();
  });

  it('starts Slack message polling from task channel bindings without payload metadata', () => {
    const options = createListenerOptions(
      {
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          description: 'Task-bound Slack job',
        },
      },
      {
        slackChannelId: 'C123',
        slackThreadTs: '111.222',
        linearSessionId: null,
      },
    );

    startPolling(options);

    expect(mockCreateSlackMessageInterval).toHaveBeenCalledWith(options);
    expect(options.state.slackMessageInterval).toBeDefined();
  });

  it('starts Linear message polling for snapshot resumes from task channel bindings', () => {
    const options = createListenerOptions(
      {
        payloadKind: TaskPayloadKind.SnapshotResume,
        payload: {
          repo: 'owner/repo',
        },
      },
      {
        slackChannelId: null,
        slackThreadTs: null,
        linearSessionId: 'linear-session-1',
      },
    );

    startPolling(options);

    expect(mockCreateLinearMessageInterval).toHaveBeenCalledWith(options);
    expect(options.state.linearMessageInterval).toBeDefined();
  });

  it('falls back to payload extraction for snapshot resumes without task bindings', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'owner/repo',
        queuedLinearMessages: [
          {
            sessionId: 'linear-session-2',
            organizationId: 'org-1',
            action: 'prompted' as const,
            timestamp: 1,
            payload: {},
          },
        ],
      },
    });

    startPolling(options);

    expect(mockCreateLinearMessageInterval).toHaveBeenCalledWith(options);
    expect(options.state.linearMessageInterval).toBeDefined();
  });

  it('starts generic communication polling for Teams-linked task runs', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Teams-originated task',
        communicationProvider: 'teams',
        communicationChannelId: '19:channel',
        communicationThreadId: 'activity-root',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).not.toHaveBeenCalled();
    expect(mockCreateCommunicationMessageInterval).toHaveBeenCalledWith({
      provider: 'teams',
      options,
    });
    expect(options.state.communicationMessageIntervals?.teams).toBeDefined();
  });

  it('starts generic communication polling for Telegram-linked task runs', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Telegram-originated task',
        communicationProvider: 'telegram',
        communicationChannelId: '-100456',
        communicationThreadId: '7',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).not.toHaveBeenCalled();
    expect(mockCreateCommunicationMessageInterval).toHaveBeenCalledWith({
      provider: 'telegram',
      options,
    });
    expect(options.state.communicationMessageIntervals?.telegram).toBeDefined();
  });

  it('starts generic communication polling for Discord-linked task runs', () => {
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Discord-originated task',
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
      },
    });

    startPolling(options);

    expect(mockCreateSlackMessageInterval).not.toHaveBeenCalled();
    expect(mockCreateCommunicationMessageInterval).toHaveBeenCalledWith({
      provider: 'discord',
      options,
    });
    expect(options.state.communicationMessageIntervals?.discord).toBeDefined();
  });

  it('passes the bootstrap source-control expiry to the refresh loop', () => {
    const expiresAt = new Date('2030-01-01T01:00:00.000Z');
    const options = createListenerOptions({
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo', description: 'Use bootstrap token' },
    });
    options.sourceControlTokenExpiresAt = expiresAt;

    startPolling(options);

    expect(mockCreateGitHubTokenRefreshInterval).toHaveBeenCalledWith({
      runId: 42,
      logger: options.logger,
      initialExpiresAt: expiresAt,
    });
  });
});
