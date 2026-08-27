const mockFindManyTaskPullRequests = vi.fn();
const mockFindFirstTaskRun = vi.fn();
const mockRecordTaskMessageEnvelope = vi.fn();
const mockNotifyFastAgentParent = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        taskPullRequests: {
          findMany: (...args: unknown[]) =>
            mockFindManyTaskPullRequests(...args),
        },
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
        },
      },
    },
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  }),
}));

vi.mock('../record-task-message-envelope', () => ({
  recordTaskMessageEnvelope: (...args: unknown[]) =>
    mockRecordTaskMessageEnvelope(...args),
}));

vi.mock('../notify-fast-agent-parent-on-pull-request-status-changed', () => ({
  notifyFastAgentParentOnPullRequestStatusChanged: (...args: unknown[]) =>
    mockNotifyFastAgentParent(...args),
}));

import {
  ACP_ENVELOPE_EVENT_TYPES,
  PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import {
  formatPrStatusChangeTaskHistoryText,
  formatPullRequestReference,
  PrStatusFastDeliveryError,
  PrStatusHistoryRecordingError,
  recordPrStatusChangeInTaskHistory,
} from '../record-pr-status-change';

describe('formatPullRequestReference', () => {
  it('uses provider-native pull request shorthand', () => {
    expect(
      formatPullRequestReference({
        repository: 'owner/repo',
        prNumber: 42,
        sourceControlProvider: 'github',
      }),
    ).toBe('owner/repo#42');

    expect(
      formatPullRequestReference({
        repository: 'group/project',
        prNumber: 42,
        sourceControlProvider: 'gitlab',
      }),
    ).toBe('group/project!42');

    expect(
      formatPullRequestReference({
        repository: 'org/project/repo',
        prNumber: 42,
        sourceControlProvider: 'ado',
      }),
    ).toBe('org/project/repo PR 42');
  });
});

describe('formatPrStatusChangeTaskHistoryText', () => {
  it('formats merged and closed status lines with a PR link', () => {
    expect(
      formatPrStatusChangeTaskHistoryText({
        repository: 'owner/repo',
        prNumber: 42,
        prTitle: 'Fix auth',
        prUrl: 'https://github.com/owner/repo/pull/42',
        status: 'merged',
        actorLogin: 'matt',
      }),
    ).toBe(
      'owner/repo#42 (Fix auth) was merged by matt\nhttps://github.com/owner/repo/pull/42',
    );

    expect(
      formatPrStatusChangeTaskHistoryText({
        repository: 'owner/repo',
        prNumber: 42,
        prTitle: 'Fix auth',
        prUrl: 'https://github.com/owner/repo/pull/42',
        status: 'closed',
        actorLogin: 'matt',
      }),
    ).toBe(
      'owner/repo#42 (Fix auth) was closed by matt\nhttps://github.com/owner/repo/pull/42',
    );
  });

  it('uses GitLab and ADO reference styles', () => {
    expect(
      formatPrStatusChangeTaskHistoryText({
        repository: 'group/project',
        prNumber: 7,
        prTitle: 'Ship it',
        prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
        status: 'merged',
        actorLogin: 'alice',
        sourceControlProvider: 'gitlab',
      }),
    ).toBe(
      'group/project!7 (Ship it) was merged by alice\nhttps://gitlab.com/group/project/-/merge_requests/7',
    );

    expect(
      formatPrStatusChangeTaskHistoryText({
        repository: 'org/project/repo',
        prNumber: 9,
        prTitle: 'Ship it',
        prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/9',
        status: 'closed',
        actorLogin: 'bob',
        sourceControlProvider: 'ado',
      }),
    ).toBe(
      'org/project/repo PR 9 (Ship it) was closed by bob\nhttps://dev.azure.com/org/project/_git/repo/pullrequest/9',
    );
  });
});

describe('recordPrStatusChangeInTaskHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockFindManyTaskPullRequests.mockResolvedValue([{ taskId: 'task-1' }]);
    mockFindFirstTaskRun.mockResolvedValue({
      id: 99,
      taskId: 'task-1',
      payload: {},
    });
    mockRecordTaskMessageEnvelope.mockResolvedValue(undefined);
    mockNotifyFastAgentParent.mockResolvedValue(undefined);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput = {
    repository: 'owner/repo',
    prNumber: 42,
    prTitle: 'Fix auth',
    prUrl: 'https://github.com/owner/repo/pull/42',
    status: 'merged' as const,
    actorLogin: 'matt',
    sourceControlProvider: 'github' as const,
  };

  it('returns no_linked_tasks when the PR is not linked', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([]);

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).resolves.toEqual(
      { recordedTaskCount: 0, reason: 'no_linked_tasks' },
    );

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('skips when the status has already been recorded', async () => {
    mockRedisSet.mockResolvedValue(null);

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).resolves.toEqual(
      { recordedTaskCount: 0, reason: 'already_recorded' },
    );

    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('records an out-of-band assistant message for each linked task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T15:30:00.123Z'));

    mockFindManyTaskPullRequests.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    mockFindFirstTaskRun
      .mockResolvedValueOnce({ id: 11, taskId: 'task-1', payload: {} })
      .mockResolvedValueOnce({ id: 22, taskId: 'task-2', payload: {} });

    await expect(
      recordPrStatusChangeInTaskHistory({
        ...baseInput,
        status: 'closed',
        actorLogin: 'alice',
      }),
    ).resolves.toEqual({ recordedTaskCount: 2 });

    const text =
      'owner/repo#42 (Fix auth) was closed by alice\nhttps://github.com/owner/repo/pull/42';
    const expectedTs = Date.parse('2026-07-12T15:30:00.123Z');

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledTimes(2);
    expect(mockNotifyFastAgentParent).toHaveBeenCalledTimes(2);
    expect(mockNotifyFastAgentParent).toHaveBeenNthCalledWith(1, {
      run: { id: 11, taskId: 'task-1', payload: {} },
      pullRequest: {
        provider: 'github',
        repository: 'owner/repo',
        number: 42,
        title: 'Fix auth',
        url: 'https://github.com/owner/repo/pull/42',
        status: 'closed',
      },
      actorLogin: 'alice',
    });
    expect(mockRecordTaskMessageEnvelope).toHaveBeenNthCalledWith(1, {
      runId: 11,
      taskId: 'task-1',
      envelope: {
        ts: expectedTs,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
        contentBlocks: [{ type: 'text', text }],
        metadata: {
          source: PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
          visibleInTranscript: true,
        },
        payload: {
          text,
          source: PR_STATUS_NOTIFICATION_TASK_MESSAGE_SOURCE,
          status: 'closed',
          repository: 'owner/repo',
          prNumber: 42,
          prUrl: 'https://github.com/owner/repo/pull/42',
          actorLogin: 'alice',
        },
        visibleInTranscript: true,
      },
    });
    expect(mockRecordTaskMessageEnvelope).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: 22,
        taskId: 'task-2',
      }),
    );
  });

  it('skips the history claim when no linked task has a run', async () => {
    mockFindFirstTaskRun.mockResolvedValue(null);

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).resolves.toEqual(
      { recordedTaskCount: 0, reason: 'no_task_runs' },
    );

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('delivers to Fast before claiming independent task history', async () => {
    mockRedisSet.mockRejectedValue(new Error('redis down'));

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).rejects.toThrow(
      PrStatusHistoryRecordingError,
    );

    expect(mockNotifyFastAgentParent).toHaveBeenCalledOnce();
    expect(mockNotifyFastAgentParent.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]!,
    );
    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('releases the claim when persistence fails so retries can succeed', async () => {
    mockRecordTaskMessageEnvelope.mockRejectedValue(new Error('db down'));

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).rejects.toThrow(
      PrStatusHistoryRecordingError,
    );

    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('continues Fast delivery for later tasks after a history failure', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    mockFindFirstTaskRun
      .mockResolvedValueOnce({ id: 11, taskId: 'task-1', payload: {} })
      .mockResolvedValueOnce({ id: 22, taskId: 'task-2', payload: {} });
    mockRecordTaskMessageEnvelope.mockRejectedValueOnce(new Error('db down'));

    await expect(recordPrStatusChangeInTaskHistory(baseInput)).rejects.toThrow(
      PrStatusHistoryRecordingError,
    );

    expect(mockNotifyFastAgentParent).toHaveBeenCalledTimes(2);
    expect(mockNotifyFastAgentParent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        run: { id: 22, taskId: 'task-2', payload: {} },
      }),
    );
    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledTimes(2);
  });

  it('reports only the later task whose Fast relay failed', async () => {
    mockFindManyTaskPullRequests.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    mockFindFirstTaskRun
      .mockResolvedValueOnce({ id: 11, taskId: 'task-1', payload: {} })
      .mockResolvedValueOnce({ id: 22, taskId: 'task-2', payload: {} });
    mockNotifyFastAgentParent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('relay unavailable'));
    mockRecordTaskMessageEnvelope.mockRejectedValueOnce(new Error('db down'));

    const error = await recordPrStatusChangeInTaskHistory(baseInput).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(PrStatusFastDeliveryError);
    expect(error.taskIds).toEqual(['task-2']);
    expect(mockNotifyFastAgentParent).toHaveBeenCalledTimes(2);
  });
});
