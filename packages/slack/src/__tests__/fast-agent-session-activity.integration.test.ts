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

  async function readState() {
    const response = await fetch(`${server.baseUrl}/mock/state`);
    expect(response.ok).toBe(true);
    return (await response.json()) as MockSlackState;
  }

  async function readSession() {
    return (await readState()).agentSessions?.find(
      (session) => session.channel === 'C1' && session.threadTs === '100.001',
    );
  }

  async function startStream(markdownText = 'Acknowledged') {
    const ts = await slack.startMessageStream({
      channel: 'C1',
      threadTs: '100.001',
      recipientTeamId: 'TWORKING',
      recipientUserId: 'U1',
      markdownText,
    });
    expect(ts).toEqual(expect.any(String));
    return ts!;
  }

  it('creates processing on stream start and reuses the thread session without losing its title', async () => {
    await startStream();
    expect(await readSession()).toMatchObject({ status: 'processing' });
    expect(
      await slack.renameAgentSession({
        channel: 'C1',
        threadTs: '100.001',
        title: 'Research',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await slack.setAgentSessionStatus({
        channel: 'C1',
        threadTs: '100.001',
        status: 'active',
      }),
    ).toMatchObject({ ok: true });

    await startStream('Next reply');
    expect((await readState()).agentSessions).toEqual([
      {
        channel: 'C1',
        threadTs: '100.001',
        status: 'processing',
        title: 'Research',
      },
    ]);
  });

  it('defaults stopStream to active even when the turn is still processing', async () => {
    // Seed independently of startStream so the missing stop transition fails on its own.
    expect(
      await slack.setAgentSessionStatus({
        channel: 'C1',
        threadTs: '100.001',
        status: 'processing',
      }),
    ).toMatchObject({ ok: true });
    const ts = await startStream();
    expect(
      await slack.appendMessageStream({
        channel: 'C1',
        ts,
        markdownText: ' progress',
      }),
    ).toBe(true);
    expect(await readSession()).toMatchObject({ status: 'processing' });
    expect(
      await slack.stopMessageStream({
        channel: 'C1',
        ts,
        markdownText: ' complete',
      }),
    ).toBe(true);
    expect(await readSession()).toMatchObject({ status: 'active' });
    expect((await readState()).messages).toEqual([
      expect.objectContaining({ ts, text: 'Acknowledged progress complete' }),
    ]);
  });

  it.each(['processing', 'suspended', 'closed'] as const)(
    'honors explicit stopStream session_status=%s without changing other threads',
    async (sessionStatus) => {
      expect(
        await slack.setAgentSessionStatus({
          channel: 'C1',
          threadTs: '200.001',
          status: 'processing',
        }),
      ).toMatchObject({ ok: true });
      const ts = await startStream();
      expect(
        await slack.stopMessageStream({ channel: 'C1', ts, sessionStatus }),
      ).toBe(true);
      expect(await readSession()).toMatchObject({ status: sessionStatus });
      expect((await readState()).agentSessions).toHaveLength(2);
      expect((await readState()).agentSessions).toContainEqual({
        channel: 'C1',
        threadTs: '200.001',
        status: 'processing',
      });
    },
  );

  it('does not create or change sessions when posting or updating ordinary messages', async () => {
    server.setState({
      ...server.getState(),
      messages: [
        {
          channel: 'C1',
          ts: '100.001',
          text: 'Question',
          user: 'U1',
          type: 'message',
        },
      ],
    });
    const ts = await slack.postMessage({
      channel: 'C1',
      thread_ts: '100.001',
      text: 'Reply',
    });
    expect(ts).toEqual(expect.any(String));
    expect(
      await slack.updateMessage({
        channel: 'C1',
        ts: ts!,
        message: { text: 'Updated' },
      }),
    ).toBe(true);
    expect(await readSession()).toBeUndefined();
    expect(
      await slack.setAgentSessionStatus({
        channel: 'C1',
        threadTs: '100.001',
        status: 'processing',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await slack.postMessage({
        channel: 'C1',
        thread_ts: '100.001',
        text: 'Progress',
      }),
    ).toEqual(expect.any(String));
    expect(await readSession()).toMatchObject({ status: 'processing' });
    expect(
      await slack.updateMessage({
        channel: 'C1',
        ts: ts!,
        message: { text: 'Final formatting' },
      }),
    ).toBe(true);
    expect(await readSession()).toMatchObject({ status: 'processing' });
  });

  it.each([false, true])(
    'keeps successive finished replies processing during silent blocked work (durable park=%s)',
    async (park) => {
      const activity = createActivity();
      activity.start();
      await vi.waitFor(async () => {
        expect(await readSession()).toMatchObject({ status: 'processing' });
      });

      // This is the real notifier/HTTP boundary, not the SDK stream or service tool executor.
      // A gate models silent outstanding work; only turn settlement may clear its status.
      let releaseWork!: () => void;
      const work = new Promise<void>((resolve) => {
        releaseWork = resolve;
      });
      let completed = false;
      const pendingWork = work.then(() => {
        completed = true;
      });
      try {
        for (const text of ['Acknowledged', 'Progress', 'Final reply']) {
          const ts = await startStream(text);
          expect(
            await slack.stopMessageStream({
              channel: 'C1',
              ts,
              sessionStatus: 'processing',
            }),
          ).toBe(true);
          expect(await readSession()).toMatchObject({ status: 'processing' });
          expect(
            await slack.updateMessage({ channel: 'C1', ts, message: { text } }),
          ).toBe(true);
          expect(await readSession()).toMatchObject({ status: 'processing' });
        }
        if (park) {
          await activity.settle({ keepProcessing: true });
          await activity.dispose();
        }
        const messages = (await readState()).messages;
        expect(messages).toHaveLength(3);
        // Check the quiet interval, not just the instant after stopStream or a repairing update.
        for (let i = 0; i < 3; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          expect(completed).toBe(false);
          expect(await readSession()).toMatchObject({ status: 'processing' });
          expect((await readState()).messages).toEqual(messages);
        }
        releaseWork();
        await pendingWork;
        const finishingActivity = park ? createActivity() : activity;
        if (park) finishingActivity.start();
        await finishingActivity.settle();
        expect(await readSession()).toMatchObject({ status: 'active' });
        expect((await readState()).messages).toEqual(messages);
      } finally {
        releaseWork();
        await pendingWork;
      }
    },
  );

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
