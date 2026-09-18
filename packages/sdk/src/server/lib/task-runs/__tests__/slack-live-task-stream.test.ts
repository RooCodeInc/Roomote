const mocks = vi.hoisted(() => ({
  findTaskRun: vi.fn(),
  renderSlackLiveTaskCard: vi.fn(),
  renderTelegramLiveTaskStream: vi.fn(),
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

vi.mock('../../telegram-live-task-stream', () => ({
  renderTelegramLiveTaskStream: mocks.renderTelegramLiveTaskStream,
}));

import { renderSlackLiveTaskCardForRun } from '../slack-live-task-stream';

describe('renderSlackLiveTaskCardForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTaskRun.mockResolvedValue({
      taskId: 'task-1',
      payload: { communicationProvider: 'slack' },
      task: { title: 'Generated title' },
    });
    mocks.renderSlackLiveTaskCard.mockResolvedValue({
      card: true,
      updated: true,
    });
    mocks.renderTelegramLiveTaskStream.mockResolvedValue({
      card: true,
      updated: true,
    });
  });

  it('routes Telegram live messages through the Telegram control-plane renderer', async () => {
    mocks.findTaskRun.mockResolvedValue({
      taskId: 'task-1',
      payload: { communicationProvider: 'telegram' },
      task: { title: 'Generated title' },
    });

    await renderSlackLiveTaskCardForRun(42, {
      status: 'in_progress',
      details: 'Running the tests.',
    });

    expect(mocks.renderTelegramLiveTaskStream).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'in_progress',
      details: 'Running the tests.',
    });
    expect(mocks.renderSlackLiveTaskCard).not.toHaveBeenCalled();
  });

  it("renders the run's own task card with the generated title", async () => {
    await expect(
      renderSlackLiveTaskCardForRun(42, {
        status: 'complete',
        details: 'Running the tests.',
        output: 'Ready for review.',
      }),
    ).resolves.toEqual({ card: true, updated: true });

    expect(mocks.renderSlackLiveTaskCard).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'complete',
      details: 'Running the tests.',
      output: 'Ready for review.',
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
