import {
  buildStartedBlocks,
  type SlackInteractivePayload,
} from '@roomote/slack';
import { RunStatus } from '@roomote/types';

const {
  dbUpdateMock,
  dbUpdateWhereMock,
  updateReturningMock,
  dbQueryFindFirstMock,
  postSlackInteractiveResponseMock,
  stopTaskRunMock,
  lookupSlackUserMappingMock,
  addReactionMock,
  slackInstallationsFindFirstMock,
} = vi.hoisted(() => ({
  dbUpdateMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  dbQueryFindFirstMock: vi.fn(),
  postSlackInteractiveResponseMock: vi.fn(),
  stopTaskRunMock: vi.fn(),
  lookupSlackUserMappingMock: vi.fn(),
  addReactionMock: vi.fn(),
  slackInstallationsFindFirstMock: vi.fn(),
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/slack')>();

  class MockSlackNotifier {
    addReaction = addReactionMock;
  }

  return {
    ...original,
    postSlackInteractiveResponse: postSlackInteractiveResponseMock,
    SlackNotifier: MockSlackNotifier,
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  taskRuns: {
    id: 'id',
    status: 'status',
    taskId: 'taskId',
    sandboxServerUrl: 'sandboxServerUrl',
    actingUserId: 'actingUserId',
    createdAt: 'createdAt',
    canceledAt: 'canceledAt',
    payload: 'payload',
  },
  slackInstallations: {
    teamId: 'teamId',
    isActive: 'isActive',
  },
  db: {
    update: dbUpdateMock,
    query: {
      taskRuns: {
        findFirst: dbQueryFindFirstMock,
      },
      slackInstallations: {
        findFirst: slackInstallationsFindFirstMock,
      },
    },
  },
  desc: vi.fn((...args: unknown[]) => ({ desc: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  isNull: vi.fn((...args: unknown[]) => ({ isNull: args })),
}));

vi.mock('../../../tasks/task-stop.js', () => ({
  stopTaskRun: stopTaskRunMock,
}));

vi.mock('../../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: lookupSlackUserMappingMock,
}));

import { handleTaskCancellation } from '../task-cancellation.js';

function buildCancellationPayload(
  actionValue: string,
  slackUserId = 'U123',
  messageBlocks?: unknown[],
): SlackInteractivePayload {
  return {
    type: 'block_actions',
    team: {
      id: 'T123',
      domain: 'acme',
    },
    user: {
      id: slackUserId,
      name: 'alice',
    },
    channel: {
      id: 'C123',
      name: 'general',
    },
    message: {
      ts: '111.222',
      blocks: messageBlocks,
    },
    actions: [
      {
        type: 'button',
        action_id: 'cancel_task',
        text: { text: 'Cancel' },
        value: actionValue,
      },
    ],
    state: {
      values: {},
    },
    response_url: 'https://slack.test/response',
    trigger_id: 'trigger-123',
  };
}

describe('handleTaskCancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    dbQueryFindFirstMock.mockResolvedValue(null);
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: dbUpdateWhereMock,
      })),
    }));
    dbUpdateWhereMock.mockReturnValue({
      returning: updateReturningMock,
    });
    postSlackInteractiveResponseMock.mockResolvedValue(undefined);
    stopTaskRunMock.mockResolvedValue({ success: true, mode: 'sandbox_stop' });
    lookupSlackUserMappingMock.mockResolvedValue({
      activeMapping: null,
      hasInactiveMapping: false,
    });
    addReactionMock.mockResolvedValue(true);
    slackInstallationsFindFirstMock.mockResolvedValue({
      botAccessToken: 'xoxb-test',
    });
  });

  it('silently ignores cancel clicks from a different Slack user', async () => {
    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
        'U456',
      ),
    );

    expect(stopTaskRunMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).not.toHaveBeenCalled();
  });

  it('confirms the task is no longer running when the stop path reports a finished task', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      userId: 'user-1',
      actingUserId: 'user-1',
    });
    stopTaskRunMock.mockResolvedValueOnce({
      success: false,
      error: 'Task is not active',
      statusCode: 409,
    });

    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
        'U123',
        buildStartedBlocks({
          workspaceDisplayName: 'App',
          taskId: 'task-1',
          initiatingSlackUserId: 'U123',
          taskUrl: 'https://example.com/task/task-1',
        }),
      ),
    );

    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      {
        replace_original: true,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Task is no longer running.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Follow',
                  emoji: false,
                },
                action_id: 'follow_task',
                url: 'https://example.com/task/task-1',
              },
            ],
          },
        ],
      },
    );
  });

  it('rejects plain-number cancel payloads', async () => {
    await handleTaskCancellation(buildCancellationPayload('42', 'U456'));

    expect(stopTaskRunMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).not.toHaveBeenCalled();
  });

  it('stops the active run with the canceling Slack user when linked', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      actingUserId: null,
      payload: {
        channel: 'C123',
        ts: '1710000000.100',
      },
    });
    lookupSlackUserMappingMock.mockResolvedValueOnce({
      activeMapping: {
        id: 'map-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        userId: 'roomote-user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      hasInactiveMapping: false,
    });

    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
      ),
    );

    expect(lookupSlackUserMappingMock).toHaveBeenCalledWith({
      slackUserId: 'U123',
      teamId: 'T123',
    });
    expect(stopTaskRunMock).toHaveBeenCalledWith({
      run: {
        id: 42,
        taskId: 'task-1',
        status: RunStatus.Running,
        sandboxServerUrl: 'http://sandbox.example.com',
        actingUserId: null,
        payload: {
          channel: 'C123',
          ts: '1710000000.100',
        },
      },
      authUserId: 'roomote-user-1',
      allowDirectCancelWithoutSandbox: true,
      terminate: true,
      cancelledBy: {
        name: 'alice',
        source: 'slack',
      },
    });
    expect(addReactionMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'x',
    });
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        replace_original: true,
      }),
    );
  });

  it('still stops when the canceler has no Roomote mapping and the run has no actor', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      actingUserId: null,
      payload: {
        channel: 'C123',
        ts: '1710000000.100',
      },
    });

    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
      ),
    );

    expect(stopTaskRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authUserId: null,
        allowDirectCancelWithoutSandbox: true,
        terminate: true,
      }),
    );
    expect(addReactionMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'x',
    });
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        replace_original: true,
      }),
    );
  });

  it('skips the cancel reaction when the origin message ts is missing', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      actingUserId: null,
      payload: { channel: 'C123' },
    });

    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
      ),
    );

    expect(addReactionMock).not.toHaveBeenCalled();
    expect(stopTaskRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminate: true }),
    );
  });

  it('still replaces the cancel message when adding the x reaction fails', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      actingUserId: null,
      payload: {
        channel: 'C123',
        ts: '1710000000.100',
      },
    });
    addReactionMock.mockRejectedValueOnce(new Error('slack unavailable'));

    await handleTaskCancellation(
      buildCancellationPayload(
        JSON.stringify({
          taskId: 'task-1',
          slackUserId: 'U123',
        }),
      ),
    );

    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        replace_original: true,
      }),
    );
  });
});
