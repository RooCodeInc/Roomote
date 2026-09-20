import type { TaskRun } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  retryFailedTaskStart: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  retryFailedTaskStart: mocks.retryFailedTaskStart,
}));

import { retryFastAgentStartup } from './fast-agent-startup-retry';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload: { fastAgentParent: parent },
    sourceRunId: null,
    actingUserId: 'user-1',
    ...overrides,
  } as TaskRun;
}

describe('retryFastAgentStartup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.retryFailedTaskStart.mockResolvedValue({
      success: true,
      run: { id: 201 },
      retryNumber: 1,
      delayMs: 1_000,
    });
  });

  it('delegates parent-approved retries to canonical failed-start retry admission', async () => {
    await expect(retryFastAgentStartup(makeRun(), parent)).resolves.toEqual({
      success: true,
      runId: 201,
    });
    expect(mocks.retryFailedTaskStart).toHaveBeenCalledWith({
      sourceRun: expect.objectContaining({ id: 200 }),
      actingUserId: 'user-1',
      trigger: 'fast_parent',
    });
  });

  it('reports the canonical retry rejection', async () => {
    mocks.retryFailedTaskStart.mockResolvedValue({
      success: false,
      reason: 'limit_reached',
      error: 'The failed-start retry limit has been reached.',
    });

    await expect(retryFastAgentStartup(makeRun(), parent)).resolves.toEqual({
      success: false,
      error: 'The failed-start retry limit has been reached.',
    });
  });
});
