import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  updateWhere: vi.fn().mockResolvedValue(undefined),
  refreshFooter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mocks.updateWhere })),
    })),
  },
  taskRuns: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('../../thread-footer-refresh', () => ({
  notifyTaskRunThreadFooterRefresh: (...args: unknown[]) =>
    mocks.refreshFooter(...args),
}));

import { updateTaskRun } from '../update-task-run';

describe('updateTaskRun footer refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes the linked footer when a resumed run reaches Running', async () => {
    await updateTaskRun(42, { status: RunStatus.Running });

    await vi.waitFor(() => {
      expect(mocks.refreshFooter).toHaveBeenCalledWith(42);
    });
  });

  it('does not label booting statuses as running from the lifecycle event', async () => {
    await updateTaskRun(42, { status: RunStatus.Preparing });

    expect(mocks.refreshFooter).not.toHaveBeenCalled();
  });
});
