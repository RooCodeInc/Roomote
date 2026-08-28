import { beforeEach, describe, expect, it, vi } from 'vitest';

const fastMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  deliverParentEvent: vi.fn(),
  slackPostMessage: vi.fn(),
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
  enqueueTask: vi.fn(),
  getOrCreateFastAgentSession: fastMocks.getSession,
}));

vi.mock('../../lib/fast-agent-parent-event', () => ({
  buildSlackClientMessageId: vi.fn(() => 'client-message-id'),
  deliverFastAgentParentEvent: fastMocks.deliverParentEvent,
}));

vi.mock('../../lib/fast-agent-provider-message', () => ({
  recordFastAgentConversationMessage: fastMocks.recordProviderMessage,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  SlackNotifier: class SlackNotifier {
    postMessage = fastMocks.slackPostMessage;
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
  releaseCustomAutomationLaunchClaim: vi.fn(),
  slackInstallationChannels: { channelId: 'slack_channels.channel_id' },
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
    fastMocks.getSession.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      compatibilityMessages: [],
    });
    fastMocks.deliverParentEvent.mockResolvedValue('delivered');
    fastMocks.slackPostMessage.mockResolvedValue('100.001');
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

  it('runs a channel-less Fast automation without enqueueing a task', async () => {
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

    expect(result.completed).toBe(true);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: expect.objectContaining({
        surface: 'automation',
        workspaceId: automation.id,
      }),
    });
    expect(fastMocks.deliverParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'automation_triggered',
          automationId: automation.id,
          trigger: 'schedule',
        }),
      }),
    );
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
      }),
    );
  });

  it('creates a Slack thread for a channel-backed Fast automation', async () => {
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
    expect(fastMocks.slackPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        client_msg_id: 'client-message-id',
        text: 'Flaky tests is running.',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({ text: 'Flaky tests' }),
            ]),
          }),
          { type: 'markdown', text: '**Flaky tests** is running.' },
          expect.objectContaining({
            type: 'actions',
            elements: [
              expect.objectContaining({
                action_id: 'late_bound_automation_configure',
              }),
            ],
          }),
        ],
      }),
    );
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'C123', threadId: '100.001' },
      },
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

    expect(result.completed).toBe(true);
    expect(fastMocks.createDiscordThread).toHaveBeenCalledWith({
      channelId: 'discord-channel-1',
      name: 'Flaky tests',
      initialText: 'Flaky tests is running in Fast mode.',
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

    expect(result.completed).toBe(true);
    expect(findUserDirectMessageDestination).toHaveBeenCalledWith(
      'slack',
      'user-1',
    );
    expect(fastMocks.slackPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D123' }),
    );
    expect(fastMocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'D123', threadId: '100.001' },
      },
    });
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
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

      expect(result.completed).toBe(true);
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
      expect(fastMocks.deliverParentEvent).toHaveBeenCalledWith(
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

  it('uses the persisted Teams DM service URL to report a parent-turn failure', async () => {
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
    fastMocks.deliverParentEvent.mockRejectedValueOnce(
      new Error('parent turn failed'),
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
      text: 'Flaky tests failed: parent turn failed',
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
      launchClaimedAt: staleClaim,
    });
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

  it('makes the configured channel available for interruption-worthy reports', async () => {
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
      'Default to finishing silently',
    );
    expect(enqueued.task.payload.description).toContain(
      'a concrete actionable or important finding',
    );
    expect(enqueued.task.payload.description).toContain(
      'Routine success, healthy status, no-change results',
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

  it("falls back to the enabling admin's DM when no report channel is configured", async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {},
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
            customAutomationId: automation.id,
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
          metadata: { serviceUrl: 'https://attacker.example/' },
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationRoute).mockResolvedValue({
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      workspaceId: 'tenant-1',
    });
    vi.mocked(buildDestinationTaskPayloadFields).mockReturnValue({
      communicationProvider: 'teams',
      communicationChannelId: '19:abc@thread.tacv2',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(findTeamsConversationRoute).toHaveBeenCalledWith(
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
    vi.mocked(findTeamsConversationRoute).mockResolvedValue(null);

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
