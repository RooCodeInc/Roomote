import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
    },
  },
  environments: {},
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: vi.fn(),
  getCustomAutomationFrequency: vi.fn(),
  listEnabledCustomAutomations: vi.fn(),
  recordCustomAutomationRunOutcome: vi.fn(),
  releaseCustomAutomationLaunchClaim: vi.fn(),
  tryClaimCustomAutomationLaunch: vi.fn(),
  slackInstallations: {},
}));

vi.mock('../destination', () => ({
  buildDestinationPromptContext: vi.fn(() => ({
    channelTag: 'slack_channel_id',
    postToolName: 'post_to_channel',
    surfaceLabel: 'Slack',
  })),
  buildDestinationTaskPayloadFields: vi.fn(() => ({})),
  findTeamsConversationServiceUrl: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(async () => ['slack', 'teams']),
}));

vi.mock('../../lib/user-direct-message', () => ({
  findUserDirectMessageDestination: vi.fn(),
}));

vi.mock('../scheduling-utils', () => ({
  DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL: 3,
  isRunDue: vi.fn(),
  resolveSlackWorkspaceTimezone: vi.fn(async () => 'UTC'),
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({
    timeZone: 'UTC',
    source: 'utc_fallback',
    updatedAt: null,
  })),
  validateCronExpression: vi.fn((value: string) => value),
  isCronRunDue: vi.fn(() => true),
}));

import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';
import { findUserDirectMessageDestination } from '../../lib/user-direct-message';

import {
  customAutomationsJob,
  runCustomAutomationNow,
} from '../custom-automations';
import {
  buildDestinationTaskPayloadFields,
  findTeamsConversationServiceUrl,
  listConnectedCommunicationProviders,
} from '../destination';
import { isRunDue } from '../scheduling-utils';

const automation = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Flaky tests',
  prompt: 'Find flaky tests and propose fixes.',
  enabled: true,
  scheduleMode: 'daily',
  environmentId: '22222222-2222-2222-2222-222222222222',
  allRepositories: false,
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
  createdByUserId: null,
  lastRunAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastLaunchedTaskId: null,
  launchClaimedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('customAutomationsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      automation as never,
    ]);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(new Date());
    vi.mocked(isRunDue).mockReturnValue(true);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue(
      undefined,
    );
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_abc',
    } as never);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue({
      channelId: 'D123',
      teamId: 'T123',
    });
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'slack',
      'teams',
    ]);
  });

  it('launches a StandardTask for due automations', async () => {
    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(tryClaimCustomAutomationLaunch).toHaveBeenCalledWith(
      automation.id,
      automation.lastRunAt,
    );
    expect(isRunDue).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'daily',
        scheduleHourLocal: 3,
      }),
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            environmentId: automation.environmentId,
            description: expect.stringContaining(automation.prompt),
            repo: '',
            customAutomationId: automation.id,
            channel: 'C123',
            slackChannel: 'C123',
          }),
        }),
        initiator: {
          kind: 'automation',
          key: 'custom_automation',
          actor: {
            externalId: automation.id,
            displayName: automation.name,
          },
        },
        title: automation.name,
        workflow: 'standard',
        surface: 'system',
        trigger: 'schedule',
        channels: { slackChannelId: 'C123' },
      }),
    );
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
        lastLaunchedTaskId: 'task_abc',
        launchClaimedAt: expect.any(Date),
      }),
    );
  });

  it('launches all-repositories automations without a named environment', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        environmentId: null,
        allRepositories: true,
      } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(db.query.environments.findFirst).not.toHaveBeenCalled();
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({ repo: ALL_REPOSITORIES }),
        }),
      }),
    );
    const enqueued = vi.mocked(enqueueTask).mock.calls[0]?.[0] as {
      task: { payload: Record<string, unknown> & { description: string } };
    };
    expect(enqueued.task.payload).not.toHaveProperty('environmentId');
    expect(enqueued.task.payload.description).toContain(
      'must include the concrete `targetRepositoryFullName`',
    );
  });

  it('passes a model override through to the launch', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, model: 'anthropic/claude-sonnet-5' } as never,
    ]);

    await customAutomationsJob();

    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          harness: 'opencode-server',
          payload: expect.objectContaining({
            harnessModelOverrides: {
              'opencode-server': 'anthropic/claude-sonnet-5',
            },
          }),
        }),
      }),
    );
  });

  it('launches on the deployment default when a persisted model is invalid', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, model: 'not-a-model' } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    const enqueued = vi.mocked(enqueueTask).mock.calls[0]?.[0] as {
      task: { harness?: string; payload: Record<string, unknown> };
    };
    expect(enqueued.task.harness).toBeUndefined();
    expect(enqueued.task.payload.harnessModelOverrides).toBeUndefined();
  });

  it('anchors the prompt to the configured report channel', async () => {
    await customAutomationsJob();

    const enqueued = vi.mocked(enqueueTask).mock.calls[0]?.[0] as {
      task: { payload: { description: string } };
    };
    expect(enqueued.task.payload.description).toContain(
      '<slack_channel_id>C123</slack_channel_id>',
    );
    expect(enqueued.task.payload.description).toContain('send_chat_reply');
    expect(enqueued.task.payload.description).toContain(
      'do not post progress updates',
    );
    expect(enqueued.task.payload.description).toContain(
      'do not mention this automation',
    );
    expect(enqueued.task.payload.description).toContain(
      '<default_report_presentation>',
    );
    expect(enqueued.task.payload.description).toContain(
      'On any conflict, follow the request',
    );
    expect(enqueued.task.payload.description).toContain(
      'normally no more than about 250 words',
    );
    expect(enqueued.task.payload.description).toContain(
      'send the detail in follow-up replies in the same thread',
    );
    expect(enqueued.task.payload.description.indexOf(automation.prompt)).toBe(
      0,
    );
  });

  it('resolves a Slack DM target for the automation owner', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-1',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
      'slack',
      'user-1',
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            channel: 'D123',
            slackChannel: 'D123',
            teamId: 'T123',
            slackTeamId: 'T123',
          }),
        }),
        channels: { slackChannelId: 'D123' },
      }),
    );
  });

  it('fails clearly when the automation owner cannot receive Slack DMs', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-1',
        },
      } as never,
    ]);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      'Flaky tests: The automation owner does not have a linked Slack account that can receive direct messages.',
    ]);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it.each([
    [
      'teams',
      'teams_user',
      {
        channelId: 'teams-dm-1',
        serviceUrl: 'https://smba.example.com/amer/',
      },
    ],
    ['discord', 'discord_user', { channelId: 'discord-dm-1' }],
    ['telegram', 'telegram_user', { channelId: 'telegram-dm-1' }],
  ] as const)(
    'resolves a %s DM target for the automation owner',
    async (provider, targetKind, resolvedDestination) => {
      vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
        {
          ...automation,
          target: {
            provider,
            targetKind,
            externalRef: 'user-1',
          },
          createdByUserId: 'user-1',
        } as never,
      ]);
      vi.mocked(findUserDirectMessageDestination).mockResolvedValue(
        resolvedDestination,
      );
      vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
        provider,
      ]);

      const result = await customAutomationsJob();

      expect(result.launchedTaskId).toBe('task_abc');
      expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
        provider,
        'user-1',
      );
      expect(buildDestinationTaskPayloadFields).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          ...resolvedDestination,
        }),
      );
    },
  );

  it('adds presentation defaults without channel anchoring when no report channel is configured', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, target: {} } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    const enqueued = vi.mocked(enqueueTask).mock.calls[0]?.[0] as {
      task: { payload: Record<string, unknown> };
      channels?: unknown;
    };
    expect(enqueued.task.payload.description).toEqual(
      expect.stringContaining(automation.prompt),
    );
    expect(enqueued.task.payload.description).toEqual(
      expect.stringContaining('<default_report_presentation>'),
    );
    expect(enqueued.task.payload.description).toEqual(
      expect.stringContaining('On any conflict, follow the request'),
    );
    expect(enqueued.task.payload.description).not.toEqual(
      expect.stringContaining('send_chat_reply'),
    );
    expect(
      String(enqueued.task.payload.description).indexOf(automation.prompt),
    ).toBe(0);
    expect(enqueued.task.payload.customAutomationId).toBeUndefined();
    expect(enqueued.task.payload.channel).toBeUndefined();
    expect(enqueued.channels).toBeUndefined();
    expect(buildDestinationTaskPayloadFields).not.toHaveBeenCalled();
  });

  it('uses hour-0 boundary for hourly schedules', async () => {
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('every_hour');

    await customAutomationsJob();

    expect(isRunDue).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'every_hour',
        scheduleHourLocal: 0,
      }),
    );
  });

  it('skips when another launcher already claimed the row', async () => {
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('skips when not due', async () => {
    vi.mocked(isRunDue).mockReturnValue(false);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(tryClaimCustomAutomationLaunch).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('resolves Teams service URL before launch', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: '19:abc@thread.tacv2',
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationServiceUrl).mockResolvedValue(
      'https://smba.trafficmanager.net/amer/',
    );
    vi.mocked(buildDestinationTaskPayloadFields).mockReturnValue({
      communicationProvider: 'teams',
      communicationChannelId: '19:abc@thread.tacv2',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(findTeamsConversationServiceUrl).toHaveBeenCalledWith(
      '19:abc@thread.tacv2',
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
          }),
        }),
      }),
    );
  });

  it('fails Teams launch when service URL cannot be resolved', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: '19:abc@thread.tacv2',
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationServiceUrl).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('service URL'),
      }),
    );
  });
});

describe('runCustomAutomationNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCustomAutomationById).mockResolvedValue(automation as never);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(new Date());
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_manual',
    } as never);
  });

  it('launches with a manual trigger', async () => {
    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'launched',
      taskId: 'task_manual',
    });
    expect(tryClaimCustomAutomationLaunch).toHaveBeenCalledWith(
      automation.id,
      automation.lastRunAt,
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        task: expect.objectContaining({
          payload: expect.objectContaining({
            description: expect.stringContaining(
              '<default_report_presentation>',
            ),
          }),
        }),
      }),
    );
  });

  it('skips manual run when a concurrent launch holds the claim', async () => {
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(null);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'Another launch is already in progress.',
    });
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('releases the launch claim when enqueue fails', async () => {
    const claimAt = new Date('2026-07-21T00:00:00.000Z');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(claimAt);
    vi.mocked(enqueueTask).mockRejectedValue(new Error('queue down'));

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(releaseCustomAutomationLaunchClaim).toHaveBeenCalledWith(
      automation.id,
      claimAt,
    );
  });

  it('fails when automation is disabled', async () => {
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      enabled: false,
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
