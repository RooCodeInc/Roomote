const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  findSession: vi.fn(),
  findInstallation: vi.fn(),
  transaction: vi.fn(),
  txUpdate: vi.fn(),
  deliveredReturning: vi.fn(),
  updateSet: vi.fn(),
  postMessage: vi.fn(),
  recordLifecycle: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mocks.findRun },
      slackQuickAnswers: { findFirst: mocks.findSession },
      slackInstallations: { findFirst: mocks.findInstallation },
    },
    transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
  slackQuickAnswers: {
    id: 'slack_quick_answers.id',
    messages: 'slack_quick_answers.messages',
    slackChannel: 'slack_quick_answers.slack_channel',
    slackThreadTs: 'slack_quick_answers.slack_thread_ts',
  },
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  taskRuns: {
    id: 'task_runs.id',
    taskId: 'task_runs.task_id',
    result: 'task_runs.result',
  },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    postMessage = mocks.postMessage;
  },
}));

import { notifyFastAgentParentOnArtifact } from '../notify-fast-agent-parent';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
};

function artifact(
  overrides: Partial<
    Parameters<typeof notifyFastAgentParentOnArtifact>[0]
  > = {},
) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    taskId: 'child-task',
    runId: 200,
    path: 'reports/result.md',
    version: 1,
    uploaded: true,
    ...overrides,
  };
}

describe('notifyFastAgentParentOnArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      id: 200,
      taskId: 'child-task',
      payload: { fastAgentParent: fastParent },
      result: {},
    });
    mocks.findSession.mockResolvedValue({ id: fastParent.sessionId });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.txUpdate.mockImplementation(() => ({
      set: (values: unknown) => {
        mocks.updateSet(values);
        return {
          where: () => ({ returning: mocks.deliveredReturning }),
        };
      },
    }));
    mocks.transaction.mockImplementation(
      async (callback: (tx: { update: typeof mocks.txUpdate }) => unknown) =>
        callback({ update: mocks.txUpdate }),
    );
    mocks.deliveredReturning.mockResolvedValue([{ id: 200 }]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('delivers each artifact version immediately through the Fast parent', async () => {
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );
    await expect(
      notifyFastAgentParentOnArtifact(
        artifact({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          version: 2,
        }),
      ),
    ).resolves.toBe('delivered');

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        client_msg_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        text: expect.stringContaining('version 2'),
      }),
    );
    expect(mocks.recordLifecycle).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_artifact_notification',
          artifactVersion: 2,
        }),
      }),
    );
  });

  it('deduplicates replayed publication for the same artifact version', async () => {
    const claimKey = 'fastAgentArtifact:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mocks.findRun
      .mockResolvedValueOnce({
        id: 200,
        taskId: 'child-task',
        payload: { fastAgentParent: fastParent },
        result: {},
      })
      .mockResolvedValueOnce({
        id: 200,
        taskId: 'child-task',
        payload: { fastAgentParent: fastParent },
        result: { [claimKey]: 'delivered' },
      });
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'already_delivered',
    );

    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });

  it('records only one parent event when concurrent replays race', async () => {
    mocks.deliveredReturning
      .mockResolvedValueOnce([{ id: 200 }])
      .mockResolvedValueOnce([]);

    await expect(
      Promise.all([
        notifyFastAgentParentOnArtifact(artifact()),
        notifyFastAgentParentOnArtifact(artifact()),
      ]),
    ).resolves.toEqual(['delivered', 'already_delivered']);

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id).toBe(
      mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id,
    );
    expect(mocks.recordLifecycle).toHaveBeenCalledOnce();
  });

  it('uses inherited Fast parent metadata on resumed runs', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 200,
      taskId: 'child-task',
      payload: {
        sourceSnapshotId: 'snap-1',
        communicationContextInherited: true,
        fastAgentParent: fastParent,
      },
      result: {},
    });

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );
    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });

  it('releases failed delivery for retry, including a missing timestamp', async () => {
    mocks.postMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('101.002');

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'failed',
    );
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id).toBe(
      mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id,
    );
  });

  it('retries the same Slack post when persistence fails after delivery', async () => {
    mocks.transaction
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(
        async (callback: (tx: { update: typeof mocks.txUpdate }) => unknown) =>
          callback({ update: mocks.txUpdate }),
      );

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'failed',
    );
    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'delivered',
    );

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id).toBe(
      mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id,
    );
    expect(mocks.recordLifecycle).toHaveBeenCalledOnce();
  });

  it('does nothing for standalone non-Fast artifacts', async () => {
    mocks.findRun.mockResolvedValueOnce({
      id: 200,
      taskId: 'child-task',
      payload: {},
      result: {},
    });

    await expect(notifyFastAgentParentOnArtifact(artifact())).resolves.toBe(
      'not_applicable',
    );
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
