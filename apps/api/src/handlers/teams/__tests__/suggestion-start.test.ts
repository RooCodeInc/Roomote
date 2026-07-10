// Unit coverage for the Teams "start idea N" suggestion-launch lifecycle: the
// conservative whole-message parser, and the claim fencing in
// launchClaimedTeamsSuggestion — finalizeWorkItemLaunched with the claim's
// launchClaimedAt token on success, releaseWorkItemClaim with the token on
// every no-launch/failure path, and a loud warn (work item id + orphaned task
// id) when the fenced finalize loses to a reclaim.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiLoggerMock,
  cancelOrphanedWorkItemRunBestEffortMock,
  finalizeWorkItemLaunchedMock,
  releaseWorkItemClaimMock,
} = vi.hoisted(() => ({
  apiLoggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  cancelOrphanedWorkItemRunBestEffortMock: vi.fn(),
  finalizeWorkItemLaunchedMock: vi.fn(),
  releaseWorkItemClaimMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  asc: vi.fn((column: unknown) => ({ asc: column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((column: unknown, values: unknown) => ({
    inArray: [column, values],
  })),
  isNotNull: vi.fn((column: unknown) => ({ isNotNull: column })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: [Array.from(strings), values],
  })),
  trackedMessages: {},
  workItems: {},
  db: {},
  claimWorkItem: vi.fn(),
  finalizeWorkItemLaunched: finalizeWorkItemLaunchedMock,
  releaseWorkItemClaim: releaseWorkItemClaimMock,
}));

vi.mock('../../../logging.js', () => ({ apiLogger: apiLoggerMock }));

vi.mock('../find-active-teams-job.js', () => ({
  stripTeamsMessageIdSuffix: (conversationId: string) =>
    conversationId.split(';messageid=')[0],
}));

vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: cancelOrphanedWorkItemRunBestEffortMock,
}));

import {
  launchClaimedTeamsSuggestion,
  parseTeamsSuggestionStartText,
  type ClaimedTeamsSuggestion,
} from '../suggestion-start.js';

describe('parseTeamsSuggestionStartText', () => {
  it.each([
    ['start idea 2', 2],
    ['idea 2', 2],
    ['Idea #3', 3],
    ['START IDEA 1!', 1],
    ['  start idea 4.  ', 4],
    ['idea 12', 12],
  ])('parses %j as idea %d', (text, expected) => {
    expect(parseTeamsSuggestionStartText(text)).toBe(expected);
  });

  it.each([
    'start idea',
    'idea two',
    'please start idea 2',
    'idea 2 and 3',
    'idea 2 please',
    'idea 0',
    'idea 123',
    'my idea 2',
    'start',
    '',
  ])('rejects %j (falls through to normal task entry)', (text) => {
    expect(parseTeamsSuggestionStartText(text)).toBeNull();
  });
});

const CLAIMED_AT = new Date('2026-07-01T12:00:00.000Z');

function buildClaimedSuggestion(): ClaimedTeamsSuggestion {
  return {
    id: 'work-item-1',
    title: 'Fix the flaky test',
    brief: 'The retry loop never terminates.',
    investigationContext: null,
    targetRepositoryFullName: 'acme/app',
    launchClaimedAt: CLAIMED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  finalizeWorkItemLaunchedMock.mockResolvedValue(true);
  releaseWorkItemClaimMock.mockResolvedValue(true);
  cancelOrphanedWorkItemRunBestEffortMock.mockResolvedValue(
    'orphaned run canceled',
  );
});

describe('launchClaimedTeamsSuggestion', () => {
  it('finalizes with the task id and the claim token on a started launch', async () => {
    const launchTask = vi.fn().mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });
    const postMessage = vi.fn();

    const outcome = await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage,
    });

    expect(outcome).toEqual({ result: 'started', cloudJobId: 7 });
    expect(launchTask).toHaveBeenCalledWith(
      expect.stringContaining('Start this suggested task: Fix the flaky test'),
    );
    expect(launchTask).toHaveBeenCalledWith(
      expect.stringContaining('Target repository: acme/app'),
    );
    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledTimes(1);
    expect(finalizeWorkItemLaunchedMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'work-item-1', taskId: 'task-1', claimedAt: CLAIMED_AT },
    );
    expect(releaseWorkItemClaimMock).not.toHaveBeenCalled();
  });

  it('cancels the orphaned run, replies correctively, and returns already_started when finalize loses the fencing guard', async () => {
    finalizeWorkItemLaunchedMock.mockResolvedValue(false);
    const launchTask = vi.fn().mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });
    const postMessage = vi.fn();

    const outcome = await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage,
    });

    // Never reported as started: the caller surfaces the claim-lose outcome.
    expect(outcome).toEqual({ result: 'already_started' });
    expect(cancelOrphanedWorkItemRunBestEffortMock).toHaveBeenCalledWith(7);
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('work-item-1'),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('task-1'),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned run canceled'),
    );
    // The launch path already posted a started acknowledgement before the
    // finalize, so the user gets a corrective follow-up.
    expect(postMessage).toHaveBeenCalledWith(
      expect.stringContaining('was already started elsewhere'),
    );
    expect(releaseWorkItemClaimMock).not.toHaveBeenCalled();
  });

  it('still logs the loud warn when the orphaned-run cancel reports a failure', async () => {
    finalizeWorkItemLaunchedMock.mockResolvedValue(false);
    // The helper never throws; a failed cancel comes back as a note.
    cancelOrphanedWorkItemRunBestEffortMock.mockResolvedValue(
      'orphaned run cancel failed: db unavailable',
    );
    const launchTask = vi.fn().mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });

    await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage: vi.fn(),
    });

    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('work-item-1'),
    );
    expect(apiLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned run cancel failed: db unavailable'),
    );
  });

  it('does not cancel or post a corrective reply when finalize succeeds', async () => {
    const launchTask = vi.fn().mockResolvedValue({
      status: 'started',
      launchResult: { id: 7, taskId: 'task-1' },
    });
    const postMessage = vi.fn();

    await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage,
    });

    expect(cancelOrphanedWorkItemRunBestEffortMock).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('releases the claim with the token when routing replies inline (no task launched)', async () => {
    const launchTask = vi.fn().mockResolvedValue({ status: 'replied_inline' });

    const outcome = await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage: vi.fn(),
    });

    expect(outcome).toEqual({ result: 'replied_inline' });
    expect(finalizeWorkItemLaunchedMock).not.toHaveBeenCalled();
    expect(releaseWorkItemClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemClaimMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt: CLAIMED_AT,
    });
  });

  it('releases the claim with the token and posts a visible failure when the launch throws', async () => {
    const launchTask = vi.fn().mockRejectedValue(new Error('enqueue exploded'));
    const postMessage = vi.fn();

    const outcome = await launchClaimedTeamsSuggestion({
      suggestion: buildClaimedSuggestion(),
      launchTask,
      postMessage,
    });

    expect(outcome).toEqual({ result: 'launch_failed' });
    expect(finalizeWorkItemLaunchedMock).not.toHaveBeenCalled();
    expect(releaseWorkItemClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemClaimMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'work-item-1',
      claimedAt: CLAIMED_AT,
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.stringContaining('Could not start'),
    );
  });
});
