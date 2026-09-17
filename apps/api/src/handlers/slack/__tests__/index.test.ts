import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchSlackEvent: vi.fn(),
  findInstallation: vi.fn(),
  redisEval: vi.fn(),
  redisValues: new Map<string, string>(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    eval: mocks.redisEval,
  }),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class SlackNotifier {},
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.findInstallation,
        }),
      }),
    }),
  },
  eq: vi.fn(),
  resolveSlackSigningSecret: vi.fn(async () => 'signing-secret'),
  slackInstallations: { teamId: 'teamId' },
}));

vi.mock('../../../logging.js', () => ({
  apiLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../constants.js', () => ({
  EVENT_DEDUP_TTL_SECONDS: 3600,
  SLACK_EVENT_DEDUP_PREFIX: 'slack:event:',
}));

vi.mock('../context.js', () => ({
  createSlackWebhookContext: vi.fn((context) => context),
}));

vi.mock('../dispatch/events.js', () => ({
  dispatchSlackEvent: mocks.dispatchSlackEvent,
}));

vi.mock('../helpers/event-normalization.js', () => ({
  getSlackWebhookEventLogDetails: vi.fn(() => ({
    callbackId: undefined,
    channel: 'C123',
    subtype: undefined,
    text: 'hello',
    threadTs: undefined,
    ts: '123.456',
    user: 'U123',
  })),
  isAppAuthoredSlackEvent: vi.fn(() => false),
  isRoomoteAuthoredSlackEvent: vi.fn(() => false),
  isRoutableAutomatedSlackAppMention: vi.fn(() => false),
  isSlackFunctionExecutedEvent: vi.fn(() => false),
}));

vi.mock('../verifySlackRequest.js', () => ({
  verifySlackRequest: vi.fn(() => ({ isValid: true })),
}));

vi.mock('../events/auth-resume.js', () => ({
  resumePendingSlackAuthRequest: vi.fn(),
}));

import { slack } from '../index.js';

const app = new Hono();
app.route('/slack', slack);

const callbackBody = JSON.stringify({
  type: 'event_callback',
  team_id: 'T123',
  event_id: 'Ev123',
  event: {
    type: 'app_mention',
    channel: 'C123',
    user: 'U123',
    text: '<@UROOMOTE> hello',
    ts: '123.456',
  },
});

async function sendCallback(): Promise<Response> {
  return app.request('/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: callbackBody,
  });
}

describe('Slack event callback deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisValues.clear();
    mocks.findInstallation.mockResolvedValue([
      {
        teamId: 'T123',
        botAccessToken: 'xoxb-token',
        botUserId: 'UROOMOTE',
        botName: 'Roomote',
        appName: 'Roomote',
      },
    ]);
    mocks.dispatchSlackEvent.mockResolvedValue(undefined);
    mocks.redisEval.mockImplementation(
      async (script: string, _keys: number, key: string, token: string) => {
        if (script.includes('local existing')) {
          const existing = mocks.redisValues.get(key);
          if (existing === 'done') {
            return 'completed';
          }
          if (existing) {
            return 'processing';
          }
          mocks.redisValues.set(key, token);
          return 'claimed';
        }
        if (mocks.redisValues.get(key) !== token) {
          return 0;
        }
        if (script.includes("redis.call('EXPIRE'")) {
          return 1;
        }
        if (script.includes("redis.call('SET'")) {
          mocks.redisValues.set(key, 'done');
          return 1;
        }
        mocks.redisValues.delete(key);
        return 1;
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('accepts a retry after dispatch fails and deduplicates after success', async () => {
    mocks.dispatchSlackEvent.mockRejectedValueOnce(
      new Error('transient database failure'),
    );

    const failedResponse = await sendCallback();
    expect(failedResponse.status).toBe(503);
    await expect(failedResponse.json()).resolves.toEqual({
      ok: false,
      error: 'slack_event_processing_failed',
    });
    expect(mocks.redisValues.has('slack:event:Ev123')).toBe(false);

    const retryResponse = await sendCallback();
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ ok: true });
    expect(mocks.redisValues.get('slack:event:Ev123')).toBe('done');

    const duplicateResponse = await sendCallback();
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual({ ok: true });
    expect(mocks.dispatchSlackEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps a redelivery retryable while the first attempt is processing', async () => {
    let rejectDispatch: ((error: Error) => void) | undefined;
    mocks.dispatchSlackEvent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    );

    const firstResponsePromise = sendCallback();
    await vi.waitFor(() => {
      expect(mocks.dispatchSlackEvent).toHaveBeenCalledTimes(1);
    });

    const redeliveryResponse = await sendCallback();
    expect(redeliveryResponse.status).toBe(503);
    await expect(redeliveryResponse.json()).resolves.toEqual({
      ok: false,
      error: 'slack_event_processing',
    });
    expect(mocks.dispatchSlackEvent).toHaveBeenCalledTimes(1);

    rejectDispatch?.(new Error('transient database failure'));
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(503);
    expect(mocks.redisValues.has('slack:event:Ev123')).toBe(false);

    const retryResponse = await sendCallback();
    expect(retryResponse.status).toBe(200);
    expect(mocks.dispatchSlackEvent).toHaveBeenCalledTimes(2);
  });

  it('renews the processing lease while dispatch remains active', async () => {
    const { slackEventLeaseRenewal } = await import('../event-gate.js');
    const originalInterval = slackEventLeaseRenewal.intervalMs;
    vi.useFakeTimers();
    slackEventLeaseRenewal.intervalMs = 10;
    mocks.dispatchSlackEvent.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    );

    try {
      const responsePromise = sendCallback();
      await vi.advanceTimersByTimeAsync(10);

      expect(mocks.redisEval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('EXPIRE'"),
        1,
        'slack:event:Ev123',
        expect.stringMatching(/^processing:/u),
        '30',
      );

      await vi.advanceTimersByTimeAsync(15);
      const response = await responsePromise;
      expect(response.status).toBe(200);
    } finally {
      slackEventLeaseRenewal.intervalMs = originalInterval;
      vi.useRealTimers();
    }
  });
});
