const mocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  release: vi.fn(),
  cancel: vi.fn(),
  getSessionForTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  finalizeWorkItemLaunched: mocks.finalize,
  releaseWorkItemClaim: mocks.release,
  getSessionForTask: mocks.getSessionForTask,
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
  resolveSuggestionOriginSessionId,
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

describe('resolveSuggestionOriginSessionId', () => {
  it('returns the Session that owns the source task', async () => {
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-origin' });

    await expect(resolveSuggestionOriginSessionId('scan-task-1')).resolves.toBe(
      'session-origin',
    );
    expect(mocks.getSessionForTask).toHaveBeenCalledWith(
      expect.anything(),
      'scan-task-1',
    );
  });

  it('returns null without a source task, without a Session, or on a lookup failure', async () => {
    await expect(resolveSuggestionOriginSessionId(null)).resolves.toBeNull();
    expect(mocks.getSessionForTask).not.toHaveBeenCalled();

    mocks.getSessionForTask.mockResolvedValueOnce(null);
    await expect(
      resolveSuggestionOriginSessionId('scan-task-1'),
    ).resolves.toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getSessionForTask.mockRejectedValueOnce(new Error('db down'));
    await expect(
      resolveSuggestionOriginSessionId('scan-task-1'),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
