import {
  buildStartedBlocks,
  type SlackInteractivePayload,
} from '@roomote/slack';
import { CloudTaskStatus } from '@roomote/types';

const {
  dbUpdateMock,
  dbUpdateWhereMock,
  updateReturningMock,
  dbQueryFindFirstMock,
  postSlackInteractiveResponseMock,
  stopTaskJobMock,
} = vi.hoisted(() => ({
  dbUpdateMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  dbQueryFindFirstMock: vi.fn(),
  postSlackInteractiveResponseMock: vi.fn(),
  stopTaskJobMock: vi.fn(),
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/slack')>();

  return {
    ...original,
    postSlackInteractiveResponse: postSlackInteractiveResponseMock,
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  cloudJobs: {
    id: 'id',
    status: 'status',
    taskId: 'taskId',
    sandboxServerUrl: 'sandboxServerUrl',
    userId: 'userId',
    actingUserId: 'actingUserId',
    createdAt: 'createdAt',
    canceledAt: 'canceledAt',
  },
  db: {
    update: dbUpdateMock,
    query: {
      cloudJobs: {
        findFirst: dbQueryFindFirstMock,
      },
    },
  },
  desc: vi.fn((...args: unknown[]) => ({ desc: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  isNull: vi.fn((...args: unknown[]) => ({ isNull: args })),
}));

vi.mock('../../../tasks/task-stop.js', () => ({
  stopTaskJob: stopTaskJobMock,
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
    stopTaskJobMock.mockResolvedValue({ success: true, mode: 'sandbox_stop' });
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

    expect(stopTaskJobMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).not.toHaveBeenCalled();
  });

  it('confirms the task is no longer running when the stop path reports a finished task', async () => {
    dbQueryFindFirstMock.mockResolvedValueOnce({
      id: 42,
      taskId: 'task-1',
      status: CloudTaskStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.com',
      userId: 'user-1',
      actingUserId: 'user-1',
    });
    stopTaskJobMock.mockResolvedValueOnce({
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

    expect(stopTaskJobMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).not.toHaveBeenCalled();
  });
});
