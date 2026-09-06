import { createFastAgentSlackSessionActivity } from '../fast-agent-session-activity';
import { MockSlackServer, type MockSlackState } from '../mock-slack-server';
import { SlackNotifier } from '../slack-notifier';

it('preserves processing over HTTP when a previous short turn receives its title', async () => {
  const server = new MockSlackServer({
    state: {
      team: { id: 'TLATETITLE', domain: 'mock-roomote' },
      acceptedBotTokens: ['xoxb-mock-token'],
      channels: [{ id: 'C1', name: 'late-title', isMember: true }],
      users: [],
    },
  });

  try {
    await server.start();
    vi.stubEnv('SLACK_API_BASE_URL', `${server.baseUrl}/api/`);
    const slack = new SlackNotifier('xoxb-mock-token');
    const createActivity = () =>
      createFastAgentSlackSessionActivity({
        slack,
        workspaceId: 'TLATETITLE',
        channel: 'C1',
        threadTs: '100.001',
        // Title locking has separate coverage; keep the notifier and HTTP transport real.
        syncTitle: async ({ title }) => {
          const result = await slack.renameAgentSession({
            channel: 'C1',
            threadTs: '100.001',
            title: title!,
          });
          expect(result.ok).toBe(true);
        },
      });
    const readSession = async () => {
      const response = await fetch(`${server.baseUrl}/mock/state`);
      expect(response.ok).toBe(true);
      const state = (await response.json()) as MockSlackState;
      return state.agentSessions?.[0];
    };

    const first = createActivity();
    first.start();
    await first.settle();
    expect(await readSession()).toMatchObject({ status: 'active' });

    const second = createActivity();
    second.start();
    await vi.waitFor(async () => {
      expect(await readSession()).toMatchObject({ status: 'processing' });
    });

    first.updateTitle?.('Late generated title');
    await vi.waitFor(async () => {
      expect(await readSession()).toMatchObject({
        status: 'processing',
        title: 'Late generated title',
      });
    });

    await second.settle();
    expect(await readSession()).toMatchObject({
      status: 'active',
      title: 'Late generated title',
    });
  } finally {
    vi.unstubAllEnvs();
    await server.stop();
  }
});
