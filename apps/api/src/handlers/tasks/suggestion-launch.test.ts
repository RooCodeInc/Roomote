const mocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  release: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  finalizeWorkItemLaunched: mocks.finalize,
  releaseWorkItemClaim: mocks.release,
}));

vi.mock('./orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: mocks.cancel,
}));

vi.mock('../fast-agent-entry.js', () => ({
  resolveFastAgentEntryMode: ({
    userDefaultEnabled,
    fastAvailable,
  }: {
    userDefaultEnabled: boolean;
    fastAvailable?: boolean;
  }) => (userDefaultEnabled && fastAvailable !== false ? 'default' : null),
}));

import {
  launchClaimedSuggestedTask,
  resolveSuggestedTaskLaunchMode,
} from './suggestion-launch';

const claimedAt = new Date('2026-08-28T00:00:00.000Z');
const suggestion = { id: 'suggestion-1', launchClaimedAt: claimedAt };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finalize.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue('orphaned run canceled');
});

describe('resolveSuggestedTaskLaunchMode', () => {
  it('selects Fast for an eligible suggestion when Fast is the default', () => {
    expect(
      resolveSuggestedTaskLaunchMode({
        fastEligible: true,
        userDefaultEnabled: true,
        fastAvailable: true,
      }),
    ).toBe('fast');
  });

  it('falls back to coding when Fast is unavailable', () => {
    expect(
      resolveSuggestedTaskLaunchMode({
        fastEligible: true,
        userDefaultEnabled: true,
        fastAvailable: false,
      }),
    ).toBe('coding');
  });

  it('keeps Fast-ineligible suggestions on coding', () => {
    expect(
      resolveSuggestedTaskLaunchMode({
        fastEligible: false,
        userDefaultEnabled: true,
        fastAvailable: true,
      }),
    ).toBe('coding');
  });

  it.each(['fast', 'coding'] as const)(
    'honors an explicit %s launch mode',
    (requiredMode) => {
      expect(
        resolveSuggestedTaskLaunchMode({
          fastEligible: requiredMode !== 'fast',
          userDefaultEnabled: requiredMode !== 'fast',
          fastAvailable: requiredMode !== 'fast',
          requiredMode,
        }),
      ).toBe(requiredMode);
    },
  );
});

describe('launchClaimedSuggestedTask', () => {
  it('finalizes an accepted launch with its task link', async () => {
    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: false,
          fastAvailable: true,
        },
        launch: async () => ({
          accepted: true,
          runId: 7,
          taskId: 'task-1',
        }),
      }),
    ).resolves.toEqual({
      status: 'started',
      mode: 'coding',
      runId: 7,
      taskId: 'task-1',
    });
    expect(mocks.finalize).toHaveBeenCalledWith(expect.anything(), {
      id: suggestion.id,
      taskId: 'task-1',
      claimedAt,
    });
  });

  it('releases a rejected launch for retry', async () => {
    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: true,
          fastAvailable: true,
        },
        launch: async () => ({ accepted: false, reason: 'busy' }),
      }),
    ).resolves.toEqual({
      status: 'rejected',
      mode: 'fast',
      reason: 'busy',
    });
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), {
      id: suggestion.id,
      claimedAt,
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('releases a startup failure and classifies it as failed', async () => {
    const error = new Error('startup failed');
    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: true,
          fastAvailable: true,
        },
        launch: async () => {
          throw error;
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', mode: 'fast', error });
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('cancels an orphaned coding run when finalization loses the fence', async () => {
    mocks.finalize.mockResolvedValue(false);
    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: false,
          fastAvailable: true,
        },
        launch: async () => ({
          accepted: true,
          runId: 7,
          taskId: 'task-1',
        }),
      }),
    ).resolves.toEqual({
      status: 'finalize_lost',
      mode: 'coding',
      runId: 7,
      taskId: 'task-1',
      cancelNote: 'orphaned run canceled',
    });
    expect(mocks.cancel).toHaveBeenCalledWith(7);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('cancels the run and releases the claim when finalization throws', async () => {
    mocks.finalize.mockRejectedValue(new Error('database unavailable'));
    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: false,
          fastAvailable: true,
        },
        launch: async () => ({
          accepted: true,
          runId: 7,
          taskId: 'task-1',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'finalize_failed',
      mode: 'coding',
      runId: 7,
      taskId: 'task-1',
    });
    expect(mocks.cancel).toHaveBeenCalledWith(7);
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), {
      id: suggestion.id,
      claimedAt,
    });
  });

  it('aborts an accepted Fast turn before releasing a failed finalization', async () => {
    const abort = vi.fn(async () => undefined);
    mocks.finalize.mockRejectedValue(new Error('database unavailable'));

    await expect(
      launchClaimedSuggestedTask({
        suggestion,
        policy: {
          fastEligible: true,
          userDefaultEnabled: true,
          fastAvailable: true,
        },
        launch: async () => ({
          accepted: true,
          runId: null,
          taskId: null,
          abort,
        }),
      }),
    ).resolves.toMatchObject({
      status: 'finalize_failed',
      mode: 'fast',
      cancelNote: 'Fast turn aborted',
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalled();
  });
});
