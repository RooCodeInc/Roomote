import type { TaskRun } from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  findInstallation: vi.fn(),
  claimReturning: vi.fn(),
  postMessage: vi.fn(),
  recordLifecycle: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackQuickAnswers: { findFirst: mocks.findSession },
      slackInstallations: { findFirst: mocks.findInstallation },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: mocks.claimReturning })),
      })),
    })),
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
  sql: vi.fn(),
  taskRuns: { id: 'task_runs.id', result: 'task_runs.result' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    postMessage = mocks.postMessage;
  },
}));

import { notifyFastAgentParentOnSettle } from '../notify-fast-agent-parent-on-settle';

function makeRun(payload: Record<string, unknown>): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
  } as TaskRun;
}

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  slackTeamId: 'T123',
  slackChannel: 'C123',
  slackThreadTs: '100.001',
};

describe('notifyFastAgentParentOnSettle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSession.mockResolvedValue({ id: fastParent.sessionId });
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('posts and records a parent-owned child lifecycle update', async () => {
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Idle,
      'Implement the fix',
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        text: expect.stringContaining(
          'The delegated task "Implement the fix" is waiting for input or review.',
        ),
      }),
    );
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_settle_notification',
          status: RunStatus.Idle,
        }),
      }),
    );
  });

  it('does nothing for independently launched tasks', async () => {
    await notifyFastAgentParentOnSettle(makeRun({}), RunStatus.Completed);

    expect(mocks.findSession).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('does not post twice when settlement was already claimed', async () => {
    mocks.claimReturning.mockResolvedValueOnce([]);

    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );

    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('releases the claim when Slack delivery fails so settlement can retry', async () => {
    mocks.postMessage
      .mockRejectedValueOnce(new Error('slack unavailable'))
      .mockResolvedValueOnce('101.002');

    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );
    await notifyFastAgentParentOnSettle(
      makeRun({ fastAgentParent: fastParent }),
      RunStatus.Completed,
    );

    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
    expect(mocks.recordLifecycle).toHaveBeenCalledOnce();
  });
});
