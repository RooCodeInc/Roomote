const mockUpdateTaskPrStatus = vi.fn();
const mockRecordPrStatusChangeInTaskHistory = vi.fn();

vi.mock('../update-task-pr-status', () => ({
  updateTaskPrStatus: (...args: unknown[]) => mockUpdateTaskPrStatus(...args),
}));

vi.mock('../../task-runs/record-pr-status-change', async () => {
  const actual = await vi.importActual<
    typeof import('../../task-runs/record-pr-status-change')
  >('../../task-runs/record-pr-status-change');

  return {
    ...actual,
    recordPrStatusChangeInTaskHistory: (...args: unknown[]) =>
      mockRecordPrStatusChangeInTaskHistory(...args),
  };
});

import { markTaskPullRequestTerminal } from '../mark-task-pull-request-terminal';

describe('markTaskPullRequestTerminal', () => {
  beforeEach(() => {
    mockUpdateTaskPrStatus.mockReset();
    mockRecordPrStatusChangeInTaskHistory.mockReset();
    mockUpdateTaskPrStatus.mockResolvedValue(undefined);
    mockRecordPrStatusChangeInTaskHistory.mockResolvedValue({
      recordedTaskCount: 1,
    });
  });

  it('updates task PR status then records history with the same terminal facts', async () => {
    await markTaskPullRequestTerminal({
      sourceControlProvider: 'gitlab',
      repository: 'acme/backend',
      prNumber: 42,
      status: 'merged',
      prTitle: 'Ship it',
      prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
      actorLogin: 'merger',
    });

    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'acme/backend',
      42,
      'merged',
    );
    expect(mockRecordPrStatusChangeInTaskHistory).toHaveBeenCalledWith({
      sourceControlProvider: 'gitlab',
      repository: 'acme/backend',
      prNumber: 42,
      status: 'merged',
      prTitle: 'Ship it',
      prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
      actorLogin: 'merger',
    });
  });

  it('swallows history failures after a successful status update', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRecordPrStatusChangeInTaskHistory.mockRejectedValue(
      new Error('history write failed'),
    );

    await expect(
      markTaskPullRequestTerminal(
        {
          sourceControlProvider: 'github',
          repository: 'acme/backend',
          prNumber: 7,
          status: 'closed',
          prTitle: 'WIP',
          prUrl: 'https://github.com/acme/backend/pull/7',
          actorLogin: 'closer',
        },
        { logLabel: 'test.closed' },
      ),
    ).resolves.toBeUndefined();

    expect(mockUpdateTaskPrStatus).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[test.closed] Failed to record PR status in task history for acme/backend#7: history write failed',
      ),
    );

    warnSpy.mockRestore();
  });

  it('propagates status-update failures and skips history recording', async () => {
    mockUpdateTaskPrStatus.mockRejectedValue(new Error('db unavailable'));

    await expect(
      markTaskPullRequestTerminal({
        sourceControlProvider: 'ado',
        repository: 'acme/Platform/backend',
        prNumber: 9,
        status: 'merged',
        prTitle: 'Done',
        prUrl: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/9',
        actorLogin: 'merger',
      }),
    ).rejects.toThrow('db unavailable');

    expect(mockRecordPrStatusChangeInTaskHistory).not.toHaveBeenCalled();
  });
});
