import { beforeEach, describe, expect, it, vi } from 'vitest';

const fastMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  enqueueParentEvent: vi.fn(),
  slackPostMessage: vi.fn(),
  slackUpdateMessage: vi.fn(),
  createDiscordProvider: vi.fn(),
  discordPostMessage: vi.fn(),
  createDiscordThread: vi.fn(),
  createTeamsProvider: vi.fn(),
  teamsPostMessage: vi.fn(),
  teamsUpdateMessage: vi.fn(),
  createTelegramProvider: vi.fn(),
  telegramPostMessage: vi.fn(),
  recordProviderMessage: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getOrCreateFastAgentSession: fastMocks.getSession,
}));

vi.mock('../../lib/fast-agent-parent-event', () => ({
  buildSlackClientMessageId: vi.fn(() => 'client-message-id'),
}));

vi.mock('../../lib/fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEvent: fastMocks.enqueueParentEvent,
}));

vi.mock('../../lib/fast-agent-provider-message', () => ({
  recordFastAgentConversationMessage: fastMocks.recordProviderMessage,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  SlackNotifier: class SlackNotifier {
    postMessage = fastMocks.slackPostMessage;
    updateMessage = fastMocks.slackUpdateMessage;
  },
}));

vi.mock('../../lib/discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    fastMocks.createDiscordProvider,
}));

vi.mock('../../lib/teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    fastMocks.createTeamsProvider,
}));

vi.mock('../../lib/telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    fastMocks.createTelegramProvider,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn() })),
    })),
    query: {
      discordInstallationChannels: { findFirst: vi.fn() },
      environments: { findFirst: vi.fn() },
      slackInstallationChannels: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  customAutomations: {
    id: 'custom_automations.id',
    launchClaimedAt: 'custom_automations.launch_claimed_at',
  },
  discordInstallationChannels: { channelId: 'discord_channels.channel_id' },
  CUSTOM_AUTOMATION_LAUNCH_STALE_CLAIM_MS: 10 * 60 * 1_000,
  environments: {},
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: vi.fn(),
  getCustomAutomationFrequency: vi.fn(),
  listEnabledCustomAutomations: vi.fn(),
  recordCustomAutomationRunOutcome: vi.fn(),
  slackInstallationChannels: { channelId: 'slack_channels.channel_id' },
  tryClaimCustomAutomationLaunch: vi.fn(),
  slackInstallations: {},
}));

vi.mock('../destination', () => ({
  findTeamsConversationRoute: vi.fn(),
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

import {
  db,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  tryClaimCustomAutomationLaunch,
} from '@roomote/db/server';
import { ALL_REPOSITORIES } from '@roomote/types';
import { findUserDirectMessageDestination } from '../../lib/user-direct-message';

import {
  customAutomationsJob,
  runCustomAutomationNow,
} from '../custom-automations';
import {
  findTeamsConversationRoute,
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
  executionMode: 'sandbox_task',
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
  createdByUserId: 'user-1',
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
    vi.mocked(recordCustomAutomationRunOutcome).mockResolvedValue(true);
    vi.mocked(isRunDue).mockReturnValue(true);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
      name: 'Backend',
    } as never);
    vi.mocked(db.query.discordInstallationChannels.findFirst).mockResolvedValue(
      {
        id: 'discord-installation-channel-1',
        installation: { guildId: 'guild-1', isActive: true },
      } as never,
    );
    vi.mocked(db.query.slackInstallationChannels.findFirst).mockResolvedValue({
      id: 'slack-installation-channel-1',
      slackInstallation: { isActive: true, teamId: 'T123' },
    } as never);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue({
      channelId: 'D123',
      teamId: 'T123',
    });
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'slack',
      'teams',
    ]);
    fastMocks.getSession.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      compatibilityMessages: [],
    });
    fastMocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'event-key',
      queued: true,
    });
    fastMocks.slackPostMessage.mockResolvedValue('100.001');
    fastMocks.slackUpdateMessage.mockResolvedValue(true);
    fastMocks.discordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'discord-dm-1',
      messageId: 'discord-message-1',
    });
    fastMocks.createDiscordThread.mockResolvedValue({
      channelId: 'discord-thread-1',
      parentChannelId: 'discord-channel-1',
      messageId: 'discord-message-1',
    });
    fastMocks.createDiscordProvider.mockResolvedValue({
      postMessage: fastMocks.discordPostMessage,
      createTaskThread: fastMocks.createDiscordThread,
    });
    fastMocks.teamsPostMessage.mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-conversation-1',
      messageId: 'teams-message-1',
    });
    fastMocks.createTeamsProvider.mockResolvedValue({
      postMessage: fastMocks.teamsPostMessage,
      updateMessage: fastMocks.teamsUpdateMessage,
    });
    fastMocks.telegramPostMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: 'telegram-chat-1',
      messageId: 'telegram-message-1',
    });
    fastMocks.createTelegramProvider.mockResolvedValue({
      postMessage: fastMocks.telegramPostMessage,
    });
  });

  it('runs a channel-less Fast automation as a stored Session', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {},
        createdByUserId: 'user-1',
      } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result).toMatchObject({ queued: true, completed: false });
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: expect.objectContaining({
        surface: 'automation',
        workspaceId: automation.id,
      }),
    });
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'automation_triggered',
          automationId: automation.id,
          trigger: 'schedule',
        }),
      }),
    );
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
      }),
    );
  });

  it('starts a channel-backed Fast automation without posting to Slack', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);

    await customAutomationsJob();

    expect(db.query.slackInstallationChannels.findFirst).toHaveBeenCalled();
    expect(fastMocks.slackPostMessage).not.toHaveBeenCalled();
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: expect.stringContaining(`${automation.id}:`),
        replyTarget: { channelId: 'C123' },
      },
    });
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.not.objectContaining({
          rootMessageId: expect.anything(),
        }),
      }),
    );
  });

  it('posts a Fast Slack startup failure to the destination', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    fastMocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('parent event admission failed'),
    );

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      'Flaky tests: parent event admission failed',
    ]);
    expect(fastMocks.slackPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        text: 'Flaky tests failed: parent event admission failed',
      }),
    );
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'failed',
        error: 'parent event admission failed',
      }),
    );
  });

  it('runs an environment automation in Fast with the environment as a hint', async () => {
    const claimAt = new Date('2026-09-04T12:00:00.000Z');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(claimAt);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(true);
    expect(result.launchedTaskId).toBeNull();
    expect(result.errors).toEqual([]);
    const eventId = `${automation.id}:${claimAt.toISOString()}`;
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: eventId,
        replyTarget: { channelId: 'C123' },
      },
    });
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith({
      parent: {
        sessionId: '33333333-3333-4333-8333-333333333333',
        conversation: expect.objectContaining({ surface: 'slack' }),
      },
      event: {
        type: 'automation_triggered',
        eventId,
        automationId: automation.id,
        automationName: automation.name,
        launchClaimedAt: claimAt.toISOString(),
        prompt: automation.prompt,
        trigger: 'schedule',
        preferredEnvironmentId: automation.environmentId,
      },
    });
    expect(fastMocks.slackPostMessage).not.toHaveBeenCalled();
  });

  it('hints all repositories without looking up an environment', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, environmentId: null, allRepositories: true } as never,
    ]);

    await customAutomationsJob();

    expect(db.query.environments.findFirst).not.toHaveBeenCalled();
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          preferredEnvironmentId: ALL_REPOSITORIES,
        }),
      }),
    );
  });

  it('drops the environment hint when the environment no longer exists', async () => {
    vi.mocked(db.query.environments.findFirst).mockResolvedValue(undefined);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(true);
    expect(result.errors).toEqual([]);
    const enqueued = fastMocks.enqueueParentEvent.mock.calls[0]?.[0] as {
      event: Record<string, unknown>;
    };
    expect(enqueued.event).not.toHaveProperty('preferredEnvironmentId');
  });

  it('passes the model and effort as delegated-task defaults', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        model: 'anthropic/claude-sonnet-5',
        reasoningEffort: 'high',
      } as never,
    ]);

    await customAutomationsJob();

    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          defaultTaskModel: 'anthropic/claude-sonnet-5',
          defaultTaskReasoningEffort: 'high',
        }),
      }),
    );
  });

  it('keeps the claim fenced when the failed outcome cannot be persisted', async () => {
    const claimAt = new Date('2026-09-01T15:15:00.000Z');
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {},
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(claimAt);
    fastMocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('parent event admission failed'),
    );
    vi.mocked(recordCustomAutomationRunOutcome).mockRejectedValueOnce(
      new Error('database offline'),
    );

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      expect.stringContaining('Failed to settle custom automation'),
    ]);
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledOnce();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(db, {
      id: automation.id,
      status: 'failed',
      error: 'parent event admission failed',
      lastRunAt: claimAt,
      launchClaimedAt: claimAt,
    });
  });

  it('preserves Discord channel thread delivery for Fast automations', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'discord-channel-1',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'discord',
    ]);

    const result = await customAutomationsJob();

    expect(result).toMatchObject({ queued: true, completed: false });
    expect(fastMocks.createDiscordThread).toHaveBeenCalledWith({
      channelId: 'discord-channel-1',
      name: 'Flaky tests',
      initialText: 'Flaky tests is running.',
    });
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'discord-thread-1',
        replyTarget: {
          channelId: 'discord-channel-1',
          threadId: 'discord-thread-1',
        },
      },
    });
  });

  it('fails closed when a configured Discord channel is unavailable', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'missing-discord-channel',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'discord',
    ]);
    vi.mocked(db.query.discordInstallationChannels.findFirst).mockResolvedValue(
      undefined,
    );

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      'Flaky tests: Discord destination is no longer available.',
    ]);
    expect(fastMocks.getSession).not.toHaveBeenCalled();
  });

  it('delivers a Slack user-backed Fast automation to the owner DM', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-1',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);

    const result = await customAutomationsJob();

    expect(result).toMatchObject({ queued: true, completed: false });
    expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
      'slack',
      'user-1',
    );
    expect(fastMocks.slackPostMessage).not.toHaveBeenCalled();
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: expect.stringContaining(`${automation.id}:`),
        replyTarget: { channelId: 'D123' },
      },
    });
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
      }),
    );
  });

  it('marks a Fast Slack DM run failed when the destination cannot be resolved', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-1',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue(null);

    const result = await customAutomationsJob();

    const error =
      'The automation owner does not have a linked Slack account that can receive direct messages.';
    expect(result.errors).toEqual([`Flaky tests: ${error}`]);
    expect(fastMocks.getSession).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(db, {
      id: automation.id,
      status: 'failed',
      error,
    });
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it.each([
    {
      provider: 'discord',
      targetKind: 'discord_user',
      channelId: 'discord-dm-1',
      surface: 'discord',
      workspaceId: 'dm',
      rootMessageId: 'discord-message-1',
    },
    {
      provider: 'teams',
      targetKind: 'teams_channel',
      channelId: 'teams-conversation-1',
      surface: 'teams',
      workspaceId: 'tenant-1',
      threadId: 'teams-message-1',
      rootMessageId: 'teams-message-1',
    },
    {
      provider: 'teams',
      targetKind: 'teams_user',
      channelId: 'teams-dm-1',
      surface: 'teams',
      workspaceId: 'tenant-1',
      rootMessageId: 'teams-message-1',
    },
    {
      provider: 'telegram',
      targetKind: 'telegram_chat',
      channelId: 'telegram-chat-1',
      surface: 'telegram',
      workspaceId: 'telegram-chat-1',
    },
    {
      provider: 'telegram',
      targetKind: 'telegram_user',
      channelId: 'telegram-dm-1',
      surface: 'telegram',
      workspaceId: 'telegram-dm-1',
    },
  ] as const)(
    'delivers a $targetKind Fast automation through the $provider surface',
    async ({
      provider,
      targetKind,
      channelId,
      surface,
      workspaceId,
      ...expected
    }) => {
      vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
        {
          ...automation,
          executionMode: 'fast',
          environmentId: null,
          target: { provider, targetKind, externalRef: channelId },
          createdByUserId: 'user-1',
        } as never,
      ]);
      vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
        provider,
      ]);
      if (targetKind.endsWith('_user')) {
        vi.mocked(findUserDirectMessageDestination).mockResolvedValue({
          channelId,
          ...(provider === 'teams'
            ? {
                teamId: 'tenant-1',
                serviceUrl: 'https://smba.example.com/amer/',
              }
            : {}),
        });
      } else if (provider === 'teams') {
        vi.mocked(findTeamsConversationRoute).mockResolvedValue({
          serviceUrl: 'https://smba.example.com/amer/',
          workspaceId: 'tenant-1',
        });
      }

      const result = await customAutomationsJob();

      expect(result).toMatchObject({ queued: true, completed: false });
      expect(fastMocks.getSession).toHaveBeenCalledWith({
        userId: 'user-1',
        conversation: expect.objectContaining({
          surface,
          workspaceId,
          replyTarget: {
            channelId,
            ...('threadId' in expected ? { threadId: expected.threadId } : {}),
            ...(provider === 'teams'
              ? { serviceUrl: 'https://smba.example.com/amer/' }
              : {}),
          },
        }),
      });
      expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            ...('rootMessageId' in expected
              ? { rootMessageId: expected.rootMessageId }
              : {}),
          }),
        }),
      );
      if ('rootMessageId' in expected) {
        expect(fastMocks.recordProviderMessage).toHaveBeenCalledWith({
          sessionId: '33333333-3333-4333-8333-333333333333',
          conversation: expect.objectContaining({ surface, workspaceId }),
          messageId: expected.rootMessageId,
        });
      }
    },
  );

  it('fails closed for a Teams service URL without a verified installation', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: 'manual-teams-conversation',
          metadata: { serviceUrl: 'https://smba.example.com/amer/' },
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(findTeamsConversationRoute).mockResolvedValue(null);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue(['teams']);

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      'Flaky tests: Teams report destination is missing a resolvable service URL.',
    ]);
    expect(fastMocks.getSession).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('uses the persisted Teams DM service URL to report an event admission failure', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {
          provider: 'teams',
          targetKind: 'teams_user',
          externalRef: 'user-1',
        },
        createdByUserId: 'user-1',
      } as never,
    ]);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue(['teams']);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue({
      channelId: 'teams-dm-1',
      teamId: 'tenant-1',
      serviceUrl: 'https://persisted.example.com/amer/',
    });
    fastMocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('parent event admission failed'),
    );
    vi.mocked(findTeamsConversationRoute).mockResolvedValue(null);

    await customAutomationsJob();

    expect(findTeamsConversationRoute).toHaveBeenCalledWith(
      'teams-dm-1',
      'tenant-1',
    );
    expect(fastMocks.teamsUpdateMessage).toHaveBeenCalledWith({
      channelId: 'teams-dm-1',
      messageId: 'teams-message-1',
      serviceUrl: 'https://persisted.example.com/amer/',
      text: 'Flaky tests failed: parent event admission failed',
      textFormat: 'markdown',
    });
  });

  it.each([
    {
      provider: 'discord',
      targetKind: 'discord_user',
      destination: { channelId: 'discord-dm-1' },
      disable: () => fastMocks.createDiscordProvider.mockResolvedValue(null),
    },
    {
      provider: 'teams',
      targetKind: 'teams_user',
      destination: {
        channelId: 'teams-dm-1',
        teamId: 'tenant-1',
        serviceUrl: 'https://smba.example.com/amer/',
      },
      disable: () => fastMocks.createTeamsProvider.mockResolvedValue(null),
    },
    {
      provider: 'telegram',
      targetKind: 'telegram_user',
      destination: { channelId: 'telegram-dm-1' },
      disable: () => fastMocks.createTelegramProvider.mockResolvedValue(null),
    },
  ] as const)(
    'fails closed when $provider Fast delivery credentials are unavailable',
    async ({ provider, targetKind, destination, disable }) => {
      vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
        {
          ...automation,
          executionMode: 'fast',
          environmentId: null,
          target: { provider, targetKind, externalRef: 'user-1' },
          createdByUserId: 'user-1',
        } as never,
      ]);
      vi.mocked(findUserDirectMessageDestination).mockResolvedValue(
        destination,
      );
      vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
        provider,
      ]);
      disable();

      const result = await customAutomationsJob();

      expect(result.errors).toEqual([
        expect.stringContaining(
          `${provider[0]!.toUpperCase()}${provider.slice(1)} is not connected`,
        ),
      ]);
      expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
        db,
        expect.objectContaining({ status: 'succeeded' }),
      );
    },
  );

  it('marks a stale Fast launch as interrupted instead of replaying it', async () => {
    const staleClaim = new Date(Date.now() - 11 * 60 * 1_000);
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        executionMode: 'fast',
        environmentId: null,
        target: {},
        createdByUserId: 'user-1',
        launchClaimedAt: staleClaim,
      } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.errors).toEqual([
      'Flaky tests: The previous Fast automation run was interrupted.',
    ]);
    expect(fastMocks.getSession).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(db, {
      id: automation.id,
      status: 'failed',
      error: 'The previous Fast automation run was interrupted.',
      lastLaunchedTaskId: null,
      lastRunAt: staleClaim,
      launchClaimedAt: staleClaim,
    });
  });

  it('fails closed when the Slack report channel is no longer connected', async () => {
    vi.mocked(db.query.slackInstallationChannels.findFirst).mockResolvedValue(
      undefined,
    );

    const result = await customAutomationsJob();

    expect(result.queued).toBe(false);
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('reports a startup failure on the surface root and rethrows', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'telegram',
          targetKind: 'telegram_chat',
          externalRef: 'telegram-chat-1',
        },
      } as never,
    ]);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'telegram',
    ]);
    fastMocks.enqueueParentEvent.mockRejectedValueOnce(new Error('queue down'));

    const result = await customAutomationsJob();

    expect(result.errors).toEqual(['Flaky tests: queue down']);
    expect(fastMocks.telegramPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'telegram-chat-1',
        text: 'Flaky tests failed: queue down',
      }),
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

    expect(result.queued).toBe(true);
    expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
      'slack',
      'user-1',
    );
    expect(fastMocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversation: expect.objectContaining({
          surface: 'slack',
          workspaceId: 'T123',
          replyTarget: { channelId: 'D123' },
        }),
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
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'teams',
      'teams_user',
      {
        channelId: 'teams-dm-1',
        teamId: 'tenant-1',
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

      expect(result.queued).toBe(true);
      expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
        provider,
        'user-1',
      );
      expect(fastMocks.getSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          conversation: expect.objectContaining({
            surface: provider,
            replyTarget: expect.objectContaining({
              channelId: resolvedDestination.channelId,
            }),
          }),
        }),
      );
    },
  );

  it('keeps a run with no report destination as a stored Session', async () => {
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue(null);
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, target: {} } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(true);
    expect(findUserDirectMessageDestination).not.toHaveBeenCalled();
    expect(fastMocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversation: {
          surface: 'automation',
          workspaceId: automation.id,
          conversationId: expect.stringContaining(`${automation.id}:`),
        },
      }),
    );
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          prompt: automation.prompt,
          preferredEnvironmentId: automation.environmentId,
        }),
      }),
    );
  });

  it('fails an ownerless environment automation until a run-as user exists', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      { ...automation, createdByUserId: null } as never,
    ]);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(false);
    expect(result.errors).toEqual([
      'Flaky tests: Fast automation run-as user is not configured.',
    ]);
    expect(fastMocks.getSession).not.toHaveBeenCalled();
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        status: 'failed',
        error: 'Fast automation run-as user is not configured.',
      }),
    );
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
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('skips when not due', async () => {
    vi.mocked(isRunDue).mockReturnValue(false);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(tryClaimCustomAutomationLaunch).not.toHaveBeenCalled();
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('resolves Teams service URL before launch', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: '19:abc@thread.tacv2',
          metadata: { serviceUrl: 'https://attacker.example/' },
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationRoute).mockResolvedValue({
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      workspaceId: 'tenant-1',
    });
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue(['teams']);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(true);
    expect(findTeamsConversationRoute).toHaveBeenCalledWith(
      '19:abc@thread.tacv2',
    );
    expect(fastMocks.teamsPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:abc@thread.tacv2',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    );
    expect(fastMocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          surface: 'teams',
          replyTarget: expect.objectContaining({
            channelId: '19:abc@thread.tacv2',
            threadId: 'teams-message-1',
            serviceUrl: 'https://smba.trafficmanager.net/amer/',
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
    vi.mocked(findTeamsConversationRoute).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.queued).toBe(false);
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
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
    vi.mocked(recordCustomAutomationRunOutcome).mockResolvedValue(true);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(db.query.slackInstallationChannels.findFirst).mockResolvedValue({
      id: 'slack-installation-channel-1',
      slackInstallation: { isActive: true, teamId: 'T123' },
    } as never);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    vi.mocked(listConnectedCommunicationProviders).mockResolvedValue([
      'slack',
      'teams',
    ]);
    fastMocks.getSession.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      compatibilityMessages: [],
    });
  });

  it('acknowledges a manual Fast run after durably queueing its event', async () => {
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      executionMode: 'fast',
      environmentId: null,
      target: {},
      createdByUserId: 'user-1',
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'xhigh',
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({ outcome: 'queued' });
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'automation_triggered',
          automationId: automation.id,
          launchClaimedAt: expect.any(String),
          trigger: 'manual',
          defaultTaskModel: 'anthropic/claude-sonnet-5',
          defaultTaskReasoningEffort: 'xhigh',
        }),
      }),
    );
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
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
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('atomically records the failed launch when enqueue fails', async () => {
    const claimAt = new Date('2026-07-21T00:00:00.000Z');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(claimAt);
    fastMocks.enqueueParentEvent.mockRejectedValueOnce(new Error('queue down'));

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(db, {
      id: automation.id,
      status: 'failed',
      error: 'queue down',
      lastRunAt: claimAt,
      launchClaimedAt: claimAt,
    });
  });

  it('reuses the failed occurrence when manually recovering a Fast run', async () => {
    const failedClaim = new Date('2026-09-01T15:15:00.000Z');
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      executionMode: 'fast',
      environmentId: null,
      target: {
        provider: 'slack',
        targetKind: 'slack_user',
        externalRef: 'user-1',
      },
      createdByUserId: 'user-1',
      lastRunAt: failedClaim,
      lastFailedAt: new Date('2026-09-01T15:16:27.282Z'),
      lastError: 'transcript persistence failed',
    } as never);
    vi.mocked(findUserDirectMessageDestination).mockResolvedValue({
      channelId: 'D123',
      teamId: 'T123',
    });
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({ outcome: 'queued' });
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: `${automation.id}:${failedClaim.toISOString()}`,
        replyTarget: { channelId: 'D123' },
      },
    });
  });

  it('preserves the original occurrence while fencing a queued Fast recovery', async () => {
    const failedClaim = new Date('2026-09-01T15:15:00.000Z');
    const recoveryClaim = new Date('2026-09-01T15:24:00.000Z');
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      executionMode: 'fast',
      environmentId: null,
      target: {},
      createdByUserId: 'user-1',
      lastRunAt: failedClaim,
      lastFailedAt: new Date('2026-09-01T15:16:27.282Z'),
      lastError: 'transcript persistence failed',
    } as never);
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(recoveryClaim);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({ outcome: 'queued' });
    expect(fastMocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventId: `${automation.id}:${failedClaim.toISOString()}`,
          launchClaimedAt: recoveryClaim.toISOString(),
        }),
      }),
    );
    expect(recordCustomAutomationRunOutcome).not.toHaveBeenCalled();
  });

  it('fails when automation is disabled', async () => {
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      enabled: false,
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(fastMocks.enqueueParentEvent).not.toHaveBeenCalled();
  });
});
