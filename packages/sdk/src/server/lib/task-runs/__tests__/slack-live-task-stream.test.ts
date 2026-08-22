const mocks = vi.hoisted(() => ({
  findTaskRun: vi.fn(),
  renderSlackLiveTaskCard: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  taskRuns: { id: 'id' },
  db: {
    query: {
      taskRuns: { findFirst: mocks.findTaskRun },
    },
  },
}));

vi.mock('@roomote/slack', () => ({
  renderSlackLiveTaskCard: mocks.renderSlackLiveTaskCard,
}));

import { renderSlackLiveTaskCardForRun } from '../slack-live-task-stream';

describe('renderSlackLiveTaskCardForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTaskRun.mockResolvedValue({
      taskId: 'task-1',
      task: { title: 'Generated title' },
    });
    mocks.renderSlackLiveTaskCard.mockResolvedValue({
      card: true,
      updated: true,
    });
  });

  it("renders the run's own task card with the generated title", async () => {
    await expect(
      renderSlackLiveTaskCardForRun(42, {
        status: 'complete',
        message: 'Ready for review.',
      }),
    ).resolves.toEqual({ card: true, updated: true });

    expect(mocks.renderSlackLiveTaskCard).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'complete',
      message: 'Ready for review.',
      taskTitle: 'Generated title',
    });
  });

  it('reports no card for an unknown run', async () => {
    mocks.findTaskRun.mockResolvedValue(undefined);

    await expect(
      renderSlackLiveTaskCardForRun(42, { status: 'in_progress' }),
    ).resolves.toEqual({ card: false, updated: false });
    expect(mocks.renderSlackLiveTaskCard).not.toHaveBeenCalled();
  });
});
