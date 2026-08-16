const mocks = vi.hoisted(() => ({
  startSlackAppMentionTask: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  startSlackAppMentionTask: mocks.startSlackAppMentionTask,
}));

import { createFastAgentTaskLauncher } from './fast-agent-task-launcher.js';

describe('createFastAgentTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startSlackAppMentionTask.mockResolvedValue({ taskId: 'task-1' });
  });

  it('uses the Slack-owned task path and keeps lifecycle reports in the source thread', async () => {
    const launchTask = createFastAgentTaskLauncher({
      event: {
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: '100.001',
        user: 'U123',
        text: 'Add a regression test',
        ts: '100.002',
      } as never,
      slackInstallation: {
        teamDomain: 'acme',
      } as never,
      userMapping: {
        slackUserId: 'U123',
      } as never,
      userId: 'user-1',
      teamId: 'T123',
    });

    await expect(
      launchTask({ prompt: 'Add a regression test', environmentId: 'env-1' }),
    ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
    expect(mocks.startSlackAppMentionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        teamId: 'T123',
        threadTs: '100.001',
        text: 'Add a regression test',
        environmentId: 'env-1',
      }),
    );
  });
});
