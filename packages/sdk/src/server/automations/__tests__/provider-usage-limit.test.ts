import { describe, expect, it, vi } from 'vitest';

import type {
  AutomationRuntime,
  ProviderUsageLimitSnapshot,
} from '@roomote/db/server';

import type { ResolvedAutomationDestination } from '../destination';

import {
  buildProviderUsageLimitWarningMessage,
  getProviderUsageLimitPeriodId,
  providerUsageLimitJob,
} from '../provider-usage-limit';

function createRedis() {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn(
      async (
        key: string,
        value: string,
        _expiryMode: 'EX',
        _ttl: number,
        _setMode: 'NX',
      ) => {
        if (values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
    ),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
  };
}

function snapshot(
  overrides: Partial<ProviderUsageLimitSnapshot> = {},
): ProviderUsageLimitSnapshot {
  return {
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    credentialFingerprint: 'abc123def456',
    credentialLabel: 'Production (abc123def456)',
    windowLabel: 'Weekly limit',
    usedPercent: 90,
    used: 90,
    remaining: 10,
    limit: 100,
    currency: 'USD',
    resetCadence: 'weekly',
    ...overrides,
  };
}

function runtime(
  overrides: Partial<AutomationRuntime> = {},
): AutomationRuntime {
  return {
    key: 'provider_usage_limit',
    enabled: true,
    scheduleMode: 'every_hour',
    lastRunAt: null,
    instructions: null,
    settings: { threshold: 85 },
    targets: [],
    scanCursor: null,
    slackChannelId: 'C-ALERTS',
    managerSlackChannelId: 'C-MANAGER',
    managerDiscordChannelId: null,
    destination: {
      provider: 'slack',
      channelId: 'C-ALERTS',
      source: 'automation_target',
    },
    ...overrides,
  };
}

function dependencies(params: {
  automationRuntime?: AutomationRuntime;
  snapshots?: ProviderUsageLimitSnapshot[];
  redis?: ReturnType<typeof createRedis>;
  now?: Date;
  communicationAdapter?: { postMessage: ReturnType<typeof vi.fn> } | null;
}) {
  const redis = params.redis ?? createRedis();
  const postMessage = vi.fn().mockResolvedValue('123.45');
  const recordOutcome = vi.fn().mockResolvedValue(undefined);
  return {
    redis,
    postMessage,
    recordOutcome,
    overrides: {
      getRuntime: vi
        .fn()
        .mockResolvedValue(params.automationRuntime ?? runtime()),
      getSlackBotToken: vi.fn().mockResolvedValue('xoxb-token'),
      getSnapshots: vi.fn().mockResolvedValue(params.snapshots ?? [snapshot()]),
      getRedisClient: () => redis,
      createNotifier: () => ({ postMessage }),
      getCommunicationAdapter: vi
        .fn()
        .mockResolvedValue(params.communicationAdapter ?? null),
      recordOutcome,
      now: () => params.now ?? new Date('2026-08-19T12:00:00.000Z'),
    },
  };
}

describe('provider usage limit automation', () => {
  it('derives weekly periods from Monday UTC', () => {
    expect(
      getProviderUsageLimitPeriodId(
        snapshot(),
        new Date('2026-08-19T12:00:00.000Z'),
      ),
    ).toBe('weekly:2026-08-17');
  });

  it('uses a provider usage alert container with only Configure', () => {
    const message = buildProviderUsageLimitWarningMessage({
      alerts: [{ snapshot: snapshot(), threshold: 85 }],
    });

    expect(message.text).toBe('OpenRouter usage is at 90%');
    expect(message.blocks[0]).toMatchObject({
      type: 'container',
      title: { text: 'Inference Provider Usage Alert' },
      subtitle: {
        type: 'mrkdwn',
        text: 'OpenRouter is at 90% ($90.00 of $100.00)',
      },
      icon: {
        image_url: expect.stringContaining(
          '/automation-icons/battery-warning.png',
        ),
      },
    });
    expect(JSON.stringify(message.blocks)).not.toContain('Production');
    expect(JSON.stringify(message.blocks)).not.toContain('abc123def456');
    expect(message.blocks[0]).toMatchObject({
      child_blocks: [
        {
          type: 'actions',
          elements: [
            expect.objectContaining({
              type: 'button',
              action_id: 'provider_usage_limit_manage_models',
              text: { type: 'plain_text', text: 'Manage models', emoji: false },
              url: expect.stringContaining('/settings/models'),
            }),
            expect.objectContaining({
              type: 'button',
              action_id: 'late_bound_automation_configure',
              text: {
                type: 'plain_text',
                text: 'Configure alert',
                emoji: false,
              },
              url: expect.stringContaining('#provider-usage-limit'),
            }),
          ],
        },
      ],
    });
  });

  it('does nothing when disabled', async () => {
    const deps = dependencies({
      automationRuntime: runtime({ enabled: false, scheduleMode: null }),
    });

    const result = await providerUsageLimitJob({}, deps.overrides);

    expect(result).toMatchObject({
      launchedTaskId: null,
      completed: false,
      skippedReason: 'Automation is disabled.',
    });
    expect(deps.overrides.getSnapshots).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('runs the hourly check even when the prior run was less than an hour ago', async () => {
    const deps = dependencies({
      automationRuntime: runtime({
        scheduleMode: 'every_hour',
        lastRunAt: new Date('2026-08-19T11:30:01.000Z'),
      }),
    });

    const result = await providerUsageLimitJob({}, deps.overrides);

    expect(result).toMatchObject({ launchedTaskId: null, completed: true });
    expect(deps.overrides.getSnapshots).toHaveBeenCalledOnce();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('alerts at the configured threshold and deduplicates scheduled runs in a quota period', async () => {
    const deps = dependencies({});

    const first = await providerUsageLimitJob({}, deps.overrides);
    const second = await providerUsageLimitJob({}, deps.overrides);

    expect(first).toMatchObject({ launchedTaskId: null, completed: true });
    expect(second).toMatchObject({ launchedTaskId: null, completed: true });
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-ALERTS' }),
    );
  });

  it('sends one critical alert when usage reaches 100% after the threshold alert', async () => {
    const snapshots = [snapshot({ usedPercent: 90, used: 90 })];
    const deps = dependencies({ snapshots });

    await providerUsageLimitJob({}, deps.overrides);
    snapshots[0] = snapshot({ usedPercent: 100, used: 100, remaining: 0 });
    await providerUsageLimitJob({}, deps.overrides);
    await providerUsageLimitJob({}, deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(deps.postMessage.mock.calls[1]?.[0])).toContain(
      'OpenRouter is at 100% ($100.00 of $100.00)',
    );
  });

  it('does not alert below the configured threshold and re-arms after usage drops', async () => {
    const redis = createRedis();
    const snapshots = [snapshot()];
    const deps = dependencies({ redis, snapshots });

    await providerUsageLimitJob({}, deps.overrides);
    snapshots[0] = snapshot({ usedPercent: 80, used: 80 });
    await providerUsageLimitJob({}, deps.overrides);
    snapshots[0] = snapshot({ usedPercent: 90, used: 90 });
    await providerUsageLimitJob({}, deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
  });

  it('posts a manual test below the configured threshold without claiming the quota period', async () => {
    const deps = dependencies({
      automationRuntime: runtime({ settings: { threshold: 85 } }),
      snapshots: [snapshot({ usedPercent: 0, used: 0, remaining: 100 })],
    });

    await providerUsageLimitJob({ manualTrigger: true }, deps.overrides);
    await providerUsageLimitJob({ manualTrigger: true }, deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(deps.redis.set).not.toHaveBeenCalled();
    expect(deps.postMessage.mock.calls[0]?.[0]).toMatchObject({
      text: 'OpenRouter usage is at 0%',
    });
    expect(JSON.stringify(deps.postMessage.mock.calls[0]?.[0])).not.toContain(
      'Manual test',
    );
  });

  it('consolidates multiple provider warnings into one Slack delivery', async () => {
    const deps = dependencies({
      snapshots: [
        snapshot(),
        snapshot({
          providerId: 'kimi-for-coding',
          providerName: 'Kimi for Coding',
          credentialFingerprint: 'def456abc123',
          credentialLabel: 'Kimi (def456abc123)',
        }),
      ],
    });

    await providerUsageLimitJob({}, deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.postMessage.mock.calls[0]?.[0]?.text).toBe(
      '2 provider usage limits need attention',
    );
    expect(deps.postMessage.mock.calls[0]?.[0]?.blocks).toHaveLength(2);
  });

  it('posts Markdown and a settings link through a non-Slack adapter', async () => {
    const adapterPostMessage = vi.fn().mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-conversation',
      messageId: 'message-1',
    });
    const destination = {
      provider: 'teams',
      channelId: 'teams-conversation',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      source: 'primary_conversation',
    } satisfies ResolvedAutomationDestination;
    const deps = dependencies({
      automationRuntime: runtime({ destination: null }),
      communicationAdapter: { postMessage: adapterPostMessage },
    });

    await providerUsageLimitJob(
      {},
      {
        ...deps.overrides,
        resolveDestination: vi.fn().mockResolvedValue(destination),
      },
    );

    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.overrides.getCommunicationAdapter).toHaveBeenCalledWith(
      'teams',
    );
    expect(adapterPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'teams-conversation',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        textFormat: 'markdown',
        text: expect.stringContaining('**Provider** OpenRouter'),
        buttons: [
          [
            expect.objectContaining({
              text: 'Automation settings',
              url: expect.stringContaining('#provider-usage-limit'),
            }),
          ],
        ],
      }),
    );
    expect(adapterPostMessage.mock.calls[0]?.[0]?.text).not.toContain(
      'Production',
    );
  });

  it('releases claims and leaves the cadence gate open when delivery fails', async () => {
    const deps = dependencies({});
    deps.postMessage.mockResolvedValueOnce(null).mockResolvedValue('123.45');

    const failed = await providerUsageLimitJob({}, deps.overrides);
    const retried = await providerUsageLimitJob({}, deps.overrides);

    expect(failed.errors).toEqual([
      'Failed to post provider usage limit alert',
    ]);
    expect(retried.completed).toBe(true);
    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(deps.recordOutcome).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({}),
      expect.objectContaining({ status: 'failed', lastRunAt: 'skip' }),
    );
  });
});
