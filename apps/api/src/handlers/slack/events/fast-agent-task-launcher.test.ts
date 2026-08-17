const mocks = vi.hoisted(() => ({
  createLauncher: vi.fn(() => vi.fn()),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentSlackTaskLauncher: mocks.createLauncher,
}));

import { createFastAgentTaskLauncher } from './fast-agent-task-launcher.js';

describe('createFastAgentTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the incoming Slack message to the shared Fast launcher', () => {
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

    expect(mocks.createLauncher).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
      messageId: '100.002',
    });
    expect(launchTask).toBe(mocks.createLauncher.mock.results[0]?.value);
  });
});
