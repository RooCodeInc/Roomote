const mocks = vi.hoisted(() => ({
  findOwner: vi.fn(),
  findTask: vi.fn(),
  findRun: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      tasks: { findFirst: mocks.findTask },
      taskRuns: { findFirst: mocks.findRun },
    },
  },
  desc: vi.fn((value: unknown) => value),
  eq: vi.fn((...values: unknown[]) => values),
  findReusableGitHubPrFollowUpOwner: mocks.findOwner,
  getReviewCodeAutomationSettings: mocks.getSettings,
  tasks: { id: 'tasks.id' },
  taskRuns: { taskId: 'taskRuns.taskId', createdAt: 'taskRuns.createdAt' },
}));

import { getLinkedTaskRelayState } from '../linked-task-relay';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack',
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

describe('getLinkedTaskRelayState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      relayReviewResultsToTask: false,
      relayEligibleCreatorIds: [],
    });
    mocks.findOwner.mockResolvedValue({ taskId: 'implementation-task' });
    mocks.findTask.mockResolvedValue({
      id: 'implementation-task',
      initiatorUserId: 'user-1',
    });
  });

  it('enables the review handoff when the linked task has a Fast parent', async () => {
    mocks.findRun.mockResolvedValue({
      payload: { fastAgentParent: fastParent },
    });

    await expect(
      getLinkedTaskRelayState({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
      }),
    ).resolves.toEqual({
      linkedTaskId: 'implementation-task',
      relayEnabled: true,
      handoffTarget: 'fast_parent',
    });
  });

  it('keeps ordinary linked-task relay disabled without a Fast parent', async () => {
    mocks.findRun.mockResolvedValue({ payload: {} });

    await expect(
      getLinkedTaskRelayState({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
      }),
    ).resolves.toEqual({
      linkedTaskId: 'implementation-task',
      relayEnabled: false,
    });
  });
});
