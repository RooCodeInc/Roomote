import { createFastAgentSlackSessionActivity } from '../fast-agent-session-activity';
import { MockSlackServer, type MockSlackState } from '../mock-slack-server';
import { SlackNotifier } from '../slack-notifier';

describe('Fast Slack working lifecycle over HTTP', () => {
  const delayMs = 30;
  let server: MockSlackServer;
  let slack: SlackNotifier;
  let activities: ReturnType<typeof createFastAgentSlackSessionActivity>[];

  beforeEach(async () => {
    activities = [];
    server = new MockSlackServer({
      state: {
        team: { id: 'TWORKING', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        channels: [{ id: 'C1', name: 'working', isMember: true }],
        users: [],
      },
    });
    await server.start();
    vi.stubEnv('SLACK_API_BASE_URL', `${server.baseUrl}/api/`);
    slack = new SlackNotifier('xoxb-mock-token');
  });

  afterEach(async () => {
    await Promise.all(activities.map((activity) => activity.dispose()));
    vi.unstubAllEnvs();
    await server.stop();
  });

  function createActivity() {
    const activity = createFastAgentSlackSessionActivity({
      slack,
      workspaceId: 'TWORKING',
      channel: 'C1',
      threadTs: '100.001',
      delayMs,
    });
    activities.push(activity);
    return activity;
  }

  async function readSession() {
    const response = await fetch(`${server.baseUrl}/mock/state`);
    expect(response.ok).toBe(true);
    const state = (await response.json()) as MockSlackState;
    return state.agentSessions?.[0];
  }

  it('does not let a disposed old turn clear successor processing', async () => {
    const first = createActivity();
    first.start();
    await vi.waitFor(async () => {
      expect(await readSession()).toMatchObject({ status: 'processing' });
    });
    await first.dispose();

    const successor = createActivity();
    successor.start();
    // Drain the successor's processing request without clearing its status.
    await successor.settle({ keepProcessing: true });
    await first.settle();
    expect(await readSession()).toMatchObject({ status: 'processing' });

    const resumed = createActivity();
    resumed.start();
    await resumed.settle();
    expect(await readSession()).toMatchObject({ status: 'active' });
  });

  it('cancels processing before debounce without creating a session or restarting', async () => {
    const activity = createActivity();
    activity.start();
    await activity.dispose();
    activity.start();
    await activity.settle();
    await new Promise((resolve) => setTimeout(resolve, delayMs * 2));
    expect(await readSession()).toBeUndefined();
  });

  it('keeps a durable park before debounce processing until a resumed successful settle', async () => {
    const parked = createActivity();
    parked.start();
    await parked.settle({ keepProcessing: true });
    expect(await readSession()).toMatchObject({ status: 'processing' });
    await parked.dispose();
    await new Promise((resolve) => setTimeout(resolve, delayMs * 2));
    expect(await readSession()).toMatchObject({ status: 'processing' });

    const resumed = createActivity();
    resumed.start();
    await parked.settle();
    expect(await readSession()).toMatchObject({ status: 'processing' });
    await resumed.settle();
    expect(await readSession()).toMatchObject({ status: 'active' });
  });
});

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
