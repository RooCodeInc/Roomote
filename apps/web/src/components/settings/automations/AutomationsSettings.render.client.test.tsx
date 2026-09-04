import type { ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
const managerInstructionsPlaceholder =
  /Optional guidance for which ideas to prioritize or avoid/;

const state = vi.hoisted(() => ({
  customAutomationsPending: false,
  customAutomationRunPendingId: null as string | null,
  customAutomations: [] as Array<{
    id: string;
    name: string;
    prompt: string;
    enabled: boolean;
    scheduleMode: 'daily' | 'weekly' | 'cron';
    cronExpression: string | null;
    model: string | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
    executionMode?: 'sandbox_task' | 'fast';
    environmentId: string;
    target: {
      provider?: 'slack' | 'discord' | 'teams' | 'telegram';
      externalRef?: string;
      targetKind?:
        | 'slack_channel'
        | 'slack_user'
        | 'discord_channel'
        | 'discord_user'
        | 'teams_channel'
        | 'teams_user'
        | 'telegram_chat'
        | 'telegram_user';
      metadata?: Record<string, unknown>;
    };
    lastRunAt: Date | null;
    lastSucceededAt: null;
    lastFailedAt: null;
    lastError: null;
    lastLaunchedTaskId: null;
    createdByName: string;
    createdAt: Date;
    updatedAt: Date;
    latestFastResult?: string | null;
  }>,
  environments: [] as Array<{ id: string; name: string }>,
  nextUpdateSettingsResult: null as {
    success: true;
    settings: Record<string, unknown>;
    reviewer: Record<string, unknown>;
    slackChannelAccessWarnings: Record<string, unknown>;
    slackChannelDisplayNames: Record<string, unknown>;
  } | null,
  settingsQuery: {
    isPending: false,
    data: {
      capabilities: {
        slackConnected: true,
        discordConnected: false,
        telegramConnected: false,
        teamsConnected: false,
        requiresSlackReconnect: false,
        missingScopes: [],
        slackWorkspaceDomain: 'acme',
        sentryConnected: false,
      },
      settings: {
        reviewer: {
          enabled: false,
          environmentScope: 'all' as const,
          environmentIds: [],
          reviewAllPullRequestAuthors: false,
          reviewOnCommit: true,
          reviewDraftPrs: true,
          publishGithubCheck: false,
          relayReviewResultsToTask: false,
          relayUsers: [],
        },
        conflictResolverFrequency: 'off' as const,
        conflictResolverMaxPrAgeDays: 7 as const,
        conflictResolverLabel: 'roomote:auto-resolve-conflicts',
        conflictResolverInstructions: null,
        reviewCodeInstructions: null as string | null,
        callRoomoteViaEmojiEnabled: false,
        callRoomoteViaEmojiName: null as string | null,
        callRoomoteViaEmojiInstructions: null as string | null,
        channelAutoStartSlackChannels: [
          {
            channelId: 'C123BUGS',
            instructions: 'Treat each message as a bug report.',
            launchMode: 'always_start' as const,
          },
        ],
        channelAutoStartDiscordChannels: [],
        managerSlackChannelId: 'C123MANAGER',
        managerDiscordChannelId: null as string | null,
        managerStatsFrequency: 'off' as const,
        managerStatsSlackChannelId: null,
        managerStatsDiscordChannelId: null,
        providerUsageLimitFrequency: 'every_hour' as const,
        providerUsageLimitThreshold: 85,
        providerUsageLimitSlackChannelId: null,
        providerUsageLimitDiscordChannelId: null,
        sentryTriageFrequency: 'off' as const,
        sentryTriageSlackChannelId: null,
        sentryTriageDiscordChannelId: null,
        sentryTriageProjectSlugs: null,
        dependabotTriageFrequency: 'off' as const,
        dependabotTriageSlackChannelId: null,
        dependabotTriageDiscordChannelId: null,
        codeqlTriageFrequency: 'off' as const,
        codeqlTriageSlackChannelId: null,
        codeqlTriageDiscordChannelId: null,
        issueFixerFrequency: 'off' as const,
        issueFixerInstructions: null,

        securityAuditorFrequency: 'off' as const,
        securityAuditorSlackChannelId: null,
        securityAuditorDiscordChannelId: null,
        codeQualityAuditorFrequency: 'off' as const,
        codeQualityAuditorSlackChannelId: null,
        codeQualityAuditorDiscordChannelId: null,
        ciFailureTriageFrequency: 'off' as const,
        ciFailureTriageSlackChannelId: null,
        ciFailureTriageDiscordChannelId: null,
        mergeAnnouncerFrequency: 'off' as 'off' | 'daily',
        mergeAnnouncerTargetProvider: null as
          | 'slack'
          | 'discord'
          | 'teams'
          | 'telegram'
          | null,
        mergeAnnouncerTargetMode: null as 'channel' | 'direct_message' | null,
        mergeAnnouncerTargetChannelId: null,
        suggesterFrequency: 'off' as const,
        suggesterSlackChannelId: null,
        suggesterDiscordChannelId: null,
        suggesterTelegramChatId: null,
        suggesterTeamsChannelId: null,
        suggesterInstructions: null,
        announcerFrequency: 'off' as const,
        announcerSlackChannelId: null,
        announcerDiscordChannelId: null,
        announcerInstructions: null,
        platformIssueSlackChannelId: null,
        platformIssueDiscordChannelId: null,
        platformIssueAlertsEnabled: true,
      },
      slackChannelDisplayNames: {
        channelAutoStartSlackChannels: {
          C123BUGS: '#bugs',
        },
        managerSlackChannel: '#roomote-managers',
        managerStatsSlackChannel: null,
        providerUsageLimitSlackChannel: null,
        suggesterSlackChannel: null,
        announcerSlackChannel: null,
        platformIssueSlackChannel: null,
        sentryTriageSlackChannel: null,
        dependabotTriageSlackChannel: null,
        codeqlTriageSlackChannel: null,

        securityAuditorSlackChannel: null,
        codeQualityAuditorSlackChannel: null,
        ciFailureTriageSlackChannel: null,
      },
      slackChannelAccessWarnings: {
        channelAutoStartSlackChannels: [],
        managerSlackChannel: null,
        managerStatsSlackChannel: null,
        providerUsageLimitSlackChannel: null,
        suggesterSlackChannel: null,
        announcerSlackChannel: null,
        platformIssueSlackChannel: null,
        sentryTriageSlackChannel: null,
        dependabotTriageSlackChannel: null,
        codeqlTriageSlackChannel: null,

        securityAuditorSlackChannel: null,
        codeQualityAuditorSlackChannel: null,
        ciFailureTriageSlackChannel: null,
      },
      reviewer: {
        enabled: false,
        environmentScope: 'all' as const,
        environmentIds: [],
        reviewAllPullRequestAuthors: false,
        reviewOnCommit: true,
        reviewDraftPrs: true,
        publishGithubCheck: false,
        relayReviewResultsToTask: false,
        relayUsers: [],
      },
      resolvedDestinations: Object.fromEntries(
        [
          'manager_stats',
          'provider_usage_limit',
          'sentry_triage',
          'dependabot_triage',
          'codeql_triage',
          'security_auditor',
          'code_quality_auditor',
          'ci_failure_triage',
          'suggester',
          'announcer',
          'platform_issue_alerts',
        ].map((key) => [
          key,
          {
            provider: 'slack',
            channelId: 'C123MANAGER',
            source: 'manager_channel',
            displayName: '#roomote-managers',
          } as {
            provider: string;
            channelId: string;
            source: string;
            displayName: string | null;
          } | null,
        ]),
      ),
      recentRuns: {},
      automationStatus: {},
    },
  },
  slackChannelsQuery: {
    isPending: false,
    isFetching: false,
    isError: false,
    data: {
      channels: [
        {
          id: 'C123MANAGER',
          name: 'roomote-managers',
          label: '#roomote-managers',
          isPrivate: false,
          isMember: true,
        },
        {
          id: 'C123BUGS',
          name: 'bugs',
          label: '#bugs',
          isPrivate: false,
          isMember: true,
        },
      ],
    },
    refetch: vi.fn(),
  },
  discordChannelsQuery: {
    isPending: false,
    isFetching: false,
    isError: false,
    data: {
      channels: [] as Array<{
        id: string;
        name: string;
        label: string;
        guildId: string;
        guildName: string | null;
      }>,
    },
    refetch: vi.fn(),
  },
}));

const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

const mutations = vi.hoisted(() => ({
  connectSlack: vi.fn(),
  updateSettings: vi.fn(),
  triggerAgent: vi.fn(),
  triggerCustomAutomation: vi.fn(),
  latestSettingsOptions: null as {
    onSuccess?: (
      result: NonNullable<typeof state.nextUpdateSettingsResult>,
    ) => void;
  } | null,
  latestTriggerOptions: null as {
    onSuccess?: (
      result: { outcome: 'launched'; taskId: string },
      variables: { automationKey: string },
    ) => void;
  } | null,
  latestCustomTriggerOptions: null as {
    onSuccess?: (result: { outcome: 'launched'; taskId: string }) => void;
  } | null,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (queryOptions: { queryKey?: unknown[] }) => {
    const key1 = queryOptions.queryKey?.[1];
    if (key1 === 'listSlackChannels' || key1 === 'listDiscordChannels') {
      return key1 === 'listSlackChannels'
        ? state.slackChannelsQuery
        : state.discordChannelsQuery;
    }

    if (key1 === 'listCustomAutomations') {
      return {
        isPending: state.customAutomationsPending,
        data: state.customAutomations,
      };
    }

    if (queryOptions.queryKey?.[0] === 'taskModels') {
      return {
        isPending: false,
        data: {
          defaultModelId: 'anthropic/claude-sonnet-5',
          chatgptConnected: false,
          openaiConnected: false,
          xaiSubscriptionConnected: false,
          xaiConnected: false,
          models: [
            {
              id: 'anthropic/claude-sonnet-5',
              displayName: 'Claude Sonnet 5',
              isDefault: true,
              metadata: { supportsReasoning: true },
            },
          ],
        },
      };
    }

    if (queryOptions.queryKey?.[0] === 'miscSettings') {
      return {
        isPending: false,
        data: {
          timeZone: null,
          effectiveTimeZone: 'UTC',
          timeZoneSource: 'utc_fallback',
        },
      };
    }

    if (queryOptions.queryKey?.[0] === 'comms') {
      return {
        data: {
          invocationIdentities: [
            {
              provider: 'slack',
              mentionText: '@roomote',
              nativeMention: '<@UROOMOTE>',
            },
            {
              provider: 'github',
              mentionText: '@roomote',
            },
          ],
        },
      };
    }

    if (
      queryOptions.queryKey?.[0] === 'environments' ||
      key1 === 'list' ||
      (Array.isArray(queryOptions.queryKey) &&
        queryOptions.queryKey.includes('environments'))
    ) {
      // environments.list and any leftover channel list keys
      if (queryOptions.queryKey?.[0] === 'environments') {
        return { isPending: false, data: state.environments };
      }
    }

    return state.settingsQuery;
  },
  useMutation: (_options?: {
    onSuccess?: (
      result: NonNullable<typeof state.nextUpdateSettingsResult>,
    ) => void;
    onError?: (...args: unknown[]) => void;
    mutationKind?: 'triggerCustomAutomation';
    mutationKey?: unknown[];
  }) => {
    return {
      isPending:
        _options?.mutationKind === 'triggerCustomAutomation' &&
        (typeof _options.mutationKey?.[1] !== 'string' ||
          _options.mutationKey[1] === state.customAutomationRunPendingId),
      mutate: vi.fn((variables: unknown) => {
        if (_options?.mutationKind === 'triggerCustomAutomation') {
          mutations.triggerCustomAutomation(variables);
        } else {
          mutations.updateSettings(variables);
        }
      }),
    };
  },
  useQueryClient: () => queryClient,
}));

vi.mock('@/hooks/slack', () => ({
  useConnectSlack: () => ({
    isPending: false,
    mutate: mutations.connectSlack,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    automations: {
      getSettings: {
        queryOptions: () => ({
          queryKey: ['automations', 'getSettings'],
        }),
        queryKey: () => ['automations', 'getSettings'],
      },
      listSlackChannels: {
        queryOptions: () => ({
          queryKey: ['automations', 'listSlackChannels'],
        }),
      },
      listDiscordChannels: {
        queryOptions: () => ({
          queryKey: ['automations', 'listDiscordChannels'],
        }),
      },
      listCustomAutomations: {
        queryOptions: () => ({
          queryKey: ['automations', 'listCustomAutomations'],
        }),
        queryKey: () => ['automations', 'listCustomAutomations'],
      },
      createCustomAutomation: {
        mutationOptions: (options?: Record<string, unknown>) => options ?? {},
      },
      updateCustomAutomation: {
        mutationOptions: (options?: Record<string, unknown>) => options ?? {},
      },
      deleteCustomAutomation: {
        mutationOptions: (options?: Record<string, unknown>) => options ?? {},
      },
      triggerCustomAutomation: {
        mutationOptions: (options?: Record<string, unknown>) => {
          mutations.latestCustomTriggerOptions =
            (options as typeof mutations.latestCustomTriggerOptions) ?? null;

          return {
            ...options,
            mutationKind: 'triggerCustomAutomation',
          };
        },
      },
      resolveCustomAutomationSchedule: {
        mutationOptions: (options?: Record<string, unknown>) => options ?? {},
      },
      updateSettings: {
        mutationOptions: (options?: Record<string, unknown>) => {
          mutations.latestSettingsOptions =
            (options as typeof mutations.latestSettingsOptions) ?? null;

          return options ?? {};
        },
      },
      triggerAutomation: {
        mutationOptions: (options?: Record<string, unknown>) => {
          mutations.latestTriggerOptions =
            (options as typeof mutations.latestTriggerOptions) ?? null;

          return options ?? {};
        },
      },
    },
    environments: {
      list: {
        queryOptions: () => ({
          queryKey: ['environments', 'list'],
        }),
      },
    },
    comms: {
      status: {
        queryOptions: () => ({
          queryKey: ['comms', 'status'],
        }),
      },
    },
    miscSettings: {
      get: {
        queryOptions: () => ({
          queryKey: ['miscSettings', 'get'],
        }),
        queryKey: () => ['miscSettings', 'get'],
      },
    },
    taskModels: {
      launchOptions: {
        queryOptions: () => ({
          queryKey: ['taskModels', 'launchOptions'],
        }),
      },
    },
  }),
}));

import {
  AutomationsSettings,
  getAutomationHistoryHref,
} from './AutomationsSettings';

async function openSuggesterCard() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: /(?:Set up|Configure) Suggest Ideas/,
    }),
  );
}

async function openReviewerCard() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: /(?:Set up|Configure) Review Code/,
    }),
  );
}

function closeAutomationDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
}

describe('AutomationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.nextUpdateSettingsResult = null;
    state.customAutomationRunPendingId = null;
    mutations.latestSettingsOptions = null;
    mutations.latestTriggerOptions = null;
    mutations.latestCustomTriggerOptions = null;
    state.settingsQuery.data.capabilities.slackConnected = true;
    state.settingsQuery.data.capabilities.discordConnected = false;
    state.settingsQuery.data.capabilities.telegramConnected = false;
    state.settingsQuery.data.capabilities.teamsConnected = false;
    state.discordChannelsQuery.data.channels = [];
    state.settingsQuery.data.settings.managerStatsDiscordChannelId = null;
    state.settingsQuery.data.settings.suggesterDiscordChannelId = null;
    state.settingsQuery.data.settings.announcerDiscordChannelId = null;
    state.settingsQuery.data.settings.platformIssueDiscordChannelId = null;
    state.settingsQuery.data.settings.managerSlackChannelId = 'C123MANAGER';
    state.settingsQuery.data.slackChannelDisplayNames.managerSlackChannel =
      '#roomote-managers';
    state.settingsQuery.data.settings.managerDiscordChannelId = null;
    state.settingsQuery.data.settings.managerStatsFrequency = 'off' as never;
    state.settingsQuery.data.settings.channelAutoStartSlackChannels = [
      {
        channelId: 'C123BUGS',
        instructions: 'Treat each message as a bug report.',
        launchMode: 'always_start' as const,
      },
    ];
    state.settingsQuery.data.settings.sentryTriageFrequency = 'off' as never;
    state.settingsQuery.data.settings.dependabotTriageFrequency =
      'off' as never;
    state.settingsQuery.data.settings.suggesterFrequency = 'off';
    state.settingsQuery.data.settings.suggesterInstructions = null;
    state.settingsQuery.data.reviewer.enabled = false;
    state.settingsQuery.data.reviewer.reviewAllPullRequestAuthors = false;
    state.settingsQuery.data.settings.reviewer.reviewAllPullRequestAuthors = false;
    state.settingsQuery.data.reviewer.reviewOnCommit = true;
    state.settingsQuery.data.reviewer.reviewDraftPrs = true;
    state.settingsQuery.data.reviewer.publishGithubCheck = false;
    state.settingsQuery.data.settings.reviewCodeInstructions = null;
    state.settingsQuery.data.reviewer.relayReviewResultsToTask = false;
    state.settingsQuery.data.reviewer.relayUsers = [];
    state.customAutomations = [];
    state.customAutomationsPending = false;
    state.settingsQuery.isPending = false;
    state.environments = [];
    for (const key of Object.keys(
      state.settingsQuery.data.resolvedDestinations,
    )) {
      state.settingsQuery.data.resolvedDestinations[key] = {
        provider: 'slack',
        channelId: 'C123MANAGER',
        source: 'manager_channel',
        displayName: '#roomote-managers',
      };
    }
    window.location.hash = '';
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('does not label automations as beta', async () => {
    render(<AutomationsSettings />);

    expect(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Weekly Manager Stats/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('shows provider usage alert enablement, channel destination, and threshold controls', async () => {
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Inference Provider Usage Alerts',
      }),
    );

    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    expect(
      screen.getByLabelText('Post alerts to this Slack channel'),
    ).toBeInTheDocument();
    const thresholdSlider = screen.getByRole('slider', {
      name: 'Provider usage alert threshold',
    });
    expect(thresholdSlider).toHaveAttribute('aria-valuemin', '5');
    expect(thresholdSlider).toHaveAttribute('aria-valuenow', '85');
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('configures Call Roomote via emoji with a name and instructions', async () => {
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Set up Call Roomote via emoji',
      }),
    );
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Allow emoji reactions to call Roomote',
      }),
    );

    expect(screen.getByLabelText('Emoji name')).toHaveAttribute(
      'placeholder',
      ':white_check_mark:',
    );
    expect(screen.getByLabelText('Additional instructions')).toBeVisible();
  });

  it('shows additional instructions for Review Code', async () => {
    state.settingsQuery.data.reviewer.enabled = true;
    state.settingsQuery.data.settings.reviewer.enabled = true;
    state.settingsQuery.data.settings.reviewCodeInstructions =
      'Focus on authorization boundaries.';

    render(<AutomationsSettings />);
    await openReviewerCard();

    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Focus on authorization boundaries.',
    );
  });

  it('explains that GitHub controls whether the review check is required', async () => {
    state.settingsQuery.data.reviewer.enabled = true;
    state.settingsQuery.data.settings.reviewer.enabled = true;

    render(<AutomationsSettings />);
    await openReviewerCard();

    expect(
      screen.getByRole('switch', {
        name: 'Publish review results as a GitHub check',
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        'GitHub branch protection or rulesets control whether this check is required for merging.',
      ),
    ).toBeVisible();
  });

  it('shows per-automation Slack destinations without requiring a manager channel', async () => {
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.managerStatsFrequency = 'weekly' as never;
    state.settingsQuery.data.settings.sentryTriageFrequency = 'daily' as never;
    state.settingsQuery.data.settings.dependabotTriageFrequency =
      'daily' as never;
    for (const key of Object.keys(
      state.settingsQuery.data.resolvedDestinations,
    )) {
      state.settingsQuery.data.resolvedDestinations[key] = null;
    }

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Weekly Manager Stats/,
      }),
    );
    expect(
      screen.getByLabelText('Post summaries to this Slack channel'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Reports to: not configured — set a Manager Channel.'),
    ).toBeInTheDocument();
    closeAutomationDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: /(?:Set up|Configure) Triage Sentry Issues/,
      }),
    );
    expect(
      screen.getByLabelText('Post follow-up work to this Slack channel'),
    ).toBeInTheDocument();
    closeAutomationDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: /(?:Set up|Configure) Triage Dependabot Alerts/,
      }),
    );

    expect(
      screen.getByLabelText('Post follow-up work to this Slack channel'),
    ).toBeInTheDocument();
    expect(screen.getByText('Select a Slack channel')).toBeInTheDocument();
    expect(
      screen.getByText('Reports to: not configured — set a Manager Channel.'),
    ).toBeInTheDocument();
  });

  it('shows a saved Discord destination and a provider-neutral placeholder when Discord is connected', async () => {
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.discordChannelsQuery.data.channels = [
      {
        id: '111222333444555666',
        name: 'automation-reports',
        label: '#automation-reports',
        guildId: 'guild-1',
        guildName: 'Acme',
      },
    ];
    state.settingsQuery.data.settings.managerStatsFrequency = 'weekly' as never;
    (
      state.settingsQuery.data.settings as Record<string, unknown>
    ).managerStatsDiscordChannelId = '111222333444555666';
    state.settingsQuery.data.settings.sentryTriageFrequency = 'daily' as never;

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Weekly Manager Stats/,
      }),
    );
    expect(
      screen.getByText('#automation-reports (Discord)'),
    ).toBeInTheDocument();
    closeAutomationDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: /(?:Set up|Configure) Triage Sentry Issues/,
      }),
    );

    // The saved Discord channel is the selected destination.
    // Pickers without a saved value use the provider-neutral placeholder.
    expect(screen.getByText('Select a channel')).toBeInTheDocument();
    expect(
      screen.queryByText('Select a Slack channel'),
    ).not.toBeInTheDocument();
  });

  it('shows Discord as the shared manager destination', async () => {
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.managerDiscordChannelId =
      '111222333444555666';
    state.discordChannelsQuery.data.channels = [
      {
        id: '111222333444555666',
        name: 'automation-reports',
        label: '#automation-reports',
        guildId: 'guild-1',
        guildName: 'Acme',
      },
    ];

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Automation output/,
      }),
    );
    const destination = await screen.findByRole('button', {
      name: /#automation-reports \(Discord\)/,
    });
    expect(destination).toBeInTheDocument();

    fireEvent.click(destination);
    expect(screen.getByLabelText('Select manager channel')).toBeInTheDocument();
    expect(
      screen.getByText('Make sure the Roomote app is added to the channel.'),
    ).toBeInTheDocument();
  });

  it('offers the platform issue alerts destination picker with a saved Discord channel selected', async () => {
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.discordChannelsQuery.data.channels = [
      {
        id: '111222333444555666',
        name: 'automation-reports',
        label: '#automation-reports',
        guildId: 'guild-1',
        guildName: 'Acme',
      },
    ];
    (
      state.settingsQuery.data.settings as Record<string, unknown>
    ).platformIssueDiscordChannelId = '111222333444555666';

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Alert on Config Errors/,
      }),
    );

    expect(
      screen.getByLabelText('Post alerts to this channel'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('#automation-reports (Discord)'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Alert on Config Errors enabled' }),
    ).toBeChecked();
  });

  it('shows the deployment-admin DM fallback for unconfigured platform issue alerts', async () => {
    state.settingsQuery.data.resolvedDestinations.platform_issue_alerts = null;
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Alert on Config Errors/,
      }),
    );

    expect(
      screen.getByText(
        'Reports to deployment admins via direct message (automatic).',
      ),
    ).toBeInTheDocument();
  });

  it('hides the launch mode picker when decision mode is disabled', async () => {
    render(<AutomationsSettings />);

    const expandButton = await screen.findByRole('button', {
      name: /(?:Set up|Configure) Auto-respond to channels/,
    });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByLabelText('Monitor this Slack channel')).toHaveValue(
        '#bugs',
      );
    });

    expect(
      screen.queryByText('When new messages arrive'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Best for bug triage channels where every message should launch investigation.',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('Task instructions (optional)'),
    ).toBeInTheDocument();
  });

  it('renders triggerable automation labels from shared metadata with local descriptions', async () => {
    render(<AutomationsSettings />);

    expect(await screen.findByText('Summarize Merged PRs')).toBeInTheDocument();
    expect(
      screen.getByText('Post a recurring digest of recently merged PRs.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Summary of Roomote's activity during the week"),
    ).toBeInTheDocument();
  });

  it('shows provider support as plain text instead of badges', async () => {
    render(<AutomationsSettings />);

    await screen.findByText('Triage Dependabot Alerts');
    const providerSupport = screen.getAllByText('GitHub only')[0]!;
    expect(providerSupport.tagName).toBe('P');
    expect(providerSupport).toHaveClass('text-sm', 'text-foreground');
  });

  it('groups built-in automations into Enabled and Available sections', async () => {
    render(<AutomationsSettings />);

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.queryByText('Source Code automations')).toBeNull();
    expect(screen.queryByText('Meta automations')).toBeNull();
  });

  it('links enabled built-in automations to their filtered task history', async () => {
    render(<AutomationsSettings />);

    expect(
      await screen.findByRole('link', {
        name: 'View previous runs for Auto-respond to channels',
      }),
    ).toHaveAttribute(
      'href',
      '/tasks?userId=automation%3Aslack_channel_auto_start',
    );
    expect(
      screen.queryByRole('link', {
        name: 'View previous runs for Review Code',
      }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['callRoomoteViaEmoji', 'call_roomote_via_emoji'],
    ['channelAutoStart', 'slack_channel_auto_start'],
    ['managerStats', 'manager_stats'],
    ['sentryTriage', 'sentry_triage'],
    ['dependabotTriage', 'dependabot_triage'],
    ['codeqlTriage', 'codeql_triage'],
    ['issueFixer', 'issue_fixer'],
    ['securityAuditor', 'security_auditor'],
    ['codeQualityAuditor', 'code_quality_auditor'],
    ['ciFailureTriage', 'ci_failure_triage'],
    ['reviewer', 'review_code'],
    ['conflictResolver', 'conflict_resolver'],
    ['suggester', 'suggester'],
    ['announcer', 'announcer'],
    ['platformIssueAlerts', 'platform_issue_alerts'],
  ] as const)(
    'builds the filtered task history link for %s',
    (automationId, automationKey) => {
      expect(getAutomationHistoryHref(automationId)).toBe(
        `/tasks?userId=${encodeURIComponent(`automation:${automationKey}`)}`,
      );
    },
  );

  it('does not add task history to non-running built-in configuration', () => {
    expect(getAutomationHistoryHref('managerChannel')).toBeNull();
  });

  it('does not add task history to provider usage alerts', () => {
    expect(getAutomationHistoryHref('providerUsageLimit')).toBeNull();
  });

  it('shows Merge announcer as a webhook-driven automation without task history', async () => {
    state.settingsQuery.data.settings.mergeAnnouncerFrequency = 'daily';
    state.settingsQuery.data.settings.mergeAnnouncerTargetProvider = 'discord';
    state.settingsQuery.data.settings.mergeAnnouncerTargetMode =
      'direct_message';
    state.settingsQuery.data.settings.mergeAnnouncerTargetChannelId = null;
    state.settingsQuery.data.capabilities.discordConnected = true;
    render(<AutomationsSettings />);

    expect(await screen.findByText('Merge announcer')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Summarize commits pushed to each active repository’s default branch and announce who pushed them.',
      ),
    ).toBeInTheDocument();
    expect(getAutomationHistoryHref('mergeAnnouncer')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Merge announcer' }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Discord');
    expect(
      screen.getByRole('combobox', { name: 'Discord destination type' }),
    ).toHaveTextContent('DM me');
  });

  it('filters available automations by category and provider-aware search', async () => {
    render(<AutomationsSettings />);

    const categoryFilter = await screen.findByRole('combobox', {
      name: 'Filter available automations by category',
    });
    expect(categoryFilter).toHaveTextContent('All');

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Search available automations' }),
      { target: { value: 'Discord' } },
    );

    expect(screen.getByText('Auto-respond to channels')).toBeInTheDocument();
    expect(screen.queryByText('Review Code')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear automation filters' }),
    );
    expect(screen.getByText('Review Code')).toBeInTheDocument();

    fireEvent.click(categoryFilter);
    fireEvent.click(await screen.findByRole('option', { name: 'Operations' }));
    expect(screen.getByText('Triage Sentry Issues')).toBeInTheDocument();
    expect(screen.queryByText('Review Code')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Call Roomote via emoji'),
    ).not.toBeInTheDocument();
  });

  it('shows independent structural skeletons for custom and built-in automations', () => {
    state.customAutomationsPending = true;
    state.settingsQuery.isPending = true;

    render(<AutomationsSettings />);

    expect(
      screen
        .getByTestId('custom-automations-skeleton')
        .querySelectorAll('[data-slot="skeleton"]'),
    ).toHaveLength(6);
    expect(
      screen
        .getByTestId('built-in-automations-skeleton')
        .querySelectorAll('[data-slot="skeleton"]'),
    ).toHaveLength(17);
  });

  it('keeps platform issue alerts enabled by default while showing the custom empty state', async () => {
    state.settingsQuery.data.settings.channelAutoStartSlackChannels = [];
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.slackChannelDisplayNames.managerSlackChannel =
      null as never;

    render(<AutomationsSettings />);

    expect(
      screen.queryByText('No built-in automations enabled yet.'),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: 'Configure Alert on Config Errors',
      }),
    ).toBeInTheDocument();
    const customEmptyState = screen.getByText(
      'No custom automations created yet.',
    );
    expect(customEmptyState.tagName).toBe('P');
    expect(customEmptyState).toHaveClass('text-sm', 'text-muted-foreground');
  });

  it('opens a built-in automation modal from its existing hash permalink', async () => {
    window.location.hash = '#reviewer';

    render(<AutomationsSettings />);

    expect(
      await screen.findByRole('dialog', { name: 'Review Code' }),
    ).toBeInTheDocument();
  });

  it('names built-in automations in run-now task toasts', () => {
    render(<AutomationsSettings />);

    act(() => {
      mutations.latestTriggerOptions?.onSuccess?.(
        { outcome: 'launched', taskId: 'task-built-in-1' },
        { automationKey: 'suggester' },
      );
    });

    expect(toast.success).toHaveBeenCalledWith(
      'Running Suggest Ideas now',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'View task' }),
      }),
    );
  });

  it('renders custom automations as a compact control list and honors their permalinks', async () => {
    state.environments = [{ id: 'env-1', name: 'Production' }];
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Weekly flaky-test scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'weekly',
        cronExpression: null,
        model: null,
        environmentId: 'env-1',
        target: { provider: 'slack', externalRef: 'C123MANAGER' },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const { rerender } = render(<AutomationsSettings />);

    expect(
      await screen.findByRole('switch', {
        name: 'Toggle Weekly flaky-test scan',
      }),
    ).toBeChecked();
    expect(screen.getByText('Weekly, in Production →')).toBeInTheDocument();
    expect(screen.getByText('Slack #roomote-managers')).toBeInTheDocument();
    expect(screen.getByText('Created by Ada')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('link', {
        name: 'View previous runs for Weekly flaky-test scan',
      }),
    ).toHaveAttribute(
      'href',
      '/tasks?userId=automation%3Acustom_automation%3Aautomation-1',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    );
    expect(mutations.triggerCustomAutomation).toHaveBeenCalledWith({
      id: 'automation-1',
    });
    act(() => {
      mutations.latestCustomTriggerOptions?.onSuccess?.({
        outcome: 'launched',
        taskId: 'task-custom-1',
      });
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Running Weekly flaky-test scan now',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'View task' }),
      }),
    );

    state.customAutomations.push({
      ...state.customAutomations[0]!,
      id: 'automation-2',
      name: 'Daily dependency scan',
    });
    state.customAutomationRunPendingId = 'automation-1';
    rerender(<AutomationsSettings />);
    expect(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Run Daily dependency scan now' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'New' })).toBeEnabled();

    state.customAutomationRunPendingId = null;
    state.customAutomations[0]!.enabled = false;
    rerender(<AutomationsSettings />);
    expect(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Configure Weekly flaky-test scan',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'View previous runs for Weekly flaky-test scan',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete Weekly flaky-test scan' }),
    ).toBeInTheDocument();

    act(() => {
      window.location.hash = '#custom-automation-automation-1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(
      await screen.findByRole('dialog', { name: 'Edit custom automation' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.queryByText('Cadence')).not.toBeInTheDocument();
    expect(screen.queryByText('Frequency')).not.toBeInTheDocument();
    expect(screen.queryByText('Destination provider')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Configure what runs, when it runs, and where the result is sent.',
      ),
    ).not.toBeInTheDocument();
  });

  it('offers and displays the all-repositories workspace target', async () => {
    state.customAutomations = [
      {
        id: 'automation-all-repos',
        name: 'Org-wide digest',
        prompt: 'Summarize work across the organization.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        environmentId: '__all_repositories__',
        target: { provider: 'slack', externalRef: 'C123MANAGER' },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);

    expect(
      await screen.findByText('Daily, in All repositories →'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
    expect(
      screen.getByRole('option', { name: 'All repositories' }),
    ).toBeInTheDocument();
  });

  it('offers Fast in the Environment menu and explains channel-less output', async () => {
    state.customAutomations = [
      {
        id: 'automation-fast',
        name: 'Fast daily digest',
        prompt: 'Summarize priorities.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: 'anthropic/claude-sonnet-5',
        reasoningEffort: 'high',
        executionMode: 'fast',
        environmentId: '__fast__',
        target: {},
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        latestFastResult: 'No actionable regressions found.',
      },
    ];

    render(<AutomationsSettings />);

    expect(await screen.findByText('Daily, in Fast →')).toBeInTheDocument();
    expect(
      screen.getByText('No actionable regressions found.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', {
        name: 'View previous runs for Fast daily digest',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Fast daily digest' }),
    );
    expect(screen.getByText('Delegated task model')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Automation effort' }),
    ).toHaveTextContent('High');
    expect(
      screen.getByText(
        'This run is stored as a Fast conversation without posting to chat.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
    expect(
      screen.getByRole('option', { name: 'Fast (no sandbox)' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Fast (no sandbox)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'automation-fast',
        model: 'anthropic/claude-sonnet-5',
        reasoningEffort: 'high',
      }),
    );
  });

  it('humanizes custom schedules and shows the last run when available', async () => {
    state.environments = [{ id: 'env-1', name: 'Production' }];
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Weekday scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'cron',
        cronExpression: '0 9 * * 1-5',
        model: null,
        environmentId: 'env-1',
        target: { provider: 'slack', externalRef: 'C123MANAGER' },
        lastRunAt: new Date(),
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);

    expect(
      await screen.findByText(
        'At 09:00 AM, Monday through Friday, in Production →',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Created by Ada/)).toHaveTextContent(
      /Created by Ada · Last run \d+s ago/,
    );
    expect(screen.queryByText('0 9 * * 1-5')).not.toBeInTheDocument();
  });

  it('shows Slack DM me as a custom automation destination', async () => {
    state.environments = [{ id: 'env-1', name: 'Production' }];
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Personal daily brief',
        prompt: 'Summarize my priorities.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        executionMode: 'fast',
        environmentId: '__fast__',
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-1',
        },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);

    expect(await screen.findByText('Slack DM me')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Personal daily brief' }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Slack destination type' }),
    ).toHaveTextContent('DM me');
    expect(
      screen.getByText(
        'Results are sent privately to your linked Slack account.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Each Fast run posts here, and replies continue the Fast session.',
      ),
    ).toBeInTheDocument();
  });

  it('shows DM me for non-Slack custom automation destinations', async () => {
    state.environments = [{ id: 'env-1', name: 'Production' }];
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Discord daily brief',
        prompt: 'Summarize my priorities.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        executionMode: 'fast',
        environmentId: '__fast__',
        target: {
          provider: 'discord',
          targetKind: 'discord_user',
          externalRef: 'user-1',
        },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);

    expect(await screen.findByText('Discord DM me')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Discord daily brief' }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Discord destination type' }),
    ).toHaveTextContent('DM me');
    expect(
      screen.getByText(
        'Results are sent privately to your linked Discord account.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Each Fast run posts here, and replies continue the Fast session.',
      ),
    ).toBeInTheDocument();
  });

  it('explains that Teams replies continue the Fast session', async () => {
    state.settingsQuery.data.capabilities.teamsConnected = true;
    state.customAutomations = [
      {
        id: 'automation-teams-fast',
        name: 'Teams daily brief',
        prompt: 'Summarize my priorities.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        executionMode: 'fast',
        environmentId: '__fast__',
        target: {
          provider: 'teams',
          targetKind: 'teams_user',
          externalRef: 'user-1',
        },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Teams daily brief',
      }),
    );

    expect(
      screen.getByText(
        'Each Fast run posts here, and replies continue the Fast session.',
      ),
    ).toBeInTheDocument();
  });

  it('only offers connected providers as custom automation destinations', async () => {
    state.settingsQuery.data.capabilities.slackConnected = false;
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.settingsQuery.data.capabilities.teamsConnected = true;
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;

    render(<AutomationsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    const destination = screen.getByRole('combobox', {
      name: 'Destination provider',
    });
    expect(destination).toHaveTextContent('Discord');

    fireEvent.click(destination);

    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Discord' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Teams' })).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Slack' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Telegram' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to None when editing a disconnected destination', async () => {
    state.settingsQuery.data.capabilities.slackConnected = false;
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Weekly flaky-test scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'weekly',
        cronExpression: null,
        model: null,
        environmentId: 'env-1',
        target: { provider: 'slack', externalRef: 'C123MANAGER' },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Weekly flaky-test scan',
      }),
    );

    const destination = screen.getByRole('combobox', {
      name: 'Destination provider',
    });
    expect(destination).toHaveTextContent('None');
    fireEvent.click(destination);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('preserves in-progress edits when capabilities finish loading', async () => {
    state.settingsQuery.isPending = true;
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Weekly flaky-test scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'weekly',
        cronExpression: null,
        model: null,
        environmentId: 'env-1',
        target: { provider: 'slack', externalRef: 'C123MANAGER' },
        lastRunAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastLaunchedTaskId: null,
        createdByName: 'Ada',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    const { rerender } = render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Weekly flaky-test scan',
      }),
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Slack');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Edited while loading' },
    });
    state.settingsQuery.isPending = false;
    rerender(<AutomationsSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Edited while loading');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Slack');
  });

  it('reflects the reviewer all-author setting in the review scope copy', async () => {
    state.settingsQuery.data.reviewer.enabled = true;
    state.settingsQuery.data.reviewer.reviewAllPullRequestAuthors = true;
    state.settingsQuery.data.settings.reviewer.reviewAllPullRequestAuthors = true;

    render(<AutomationsSettings />);
    await openReviewerCard();

    expect(
      screen.getByRole('switch', { name: /review prs not created by/i }),
    ).toBeChecked();
    expect(
      screen.getByText(/Automatically review new PRs and follow-up commits/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Which PRs get reviewed/i),
    ).not.toBeInTheDocument();
  });

  it('keeps the legacy suggester textarea when grouped routing is disabled', async () => {
    state.settingsQuery.data.settings.suggesterFrequency = 'daily' as never;

    render(<AutomationsSettings />);
    await openSuggesterCard();

    expect(
      screen.getByText(
        'Reports to #roomote-managers (Slack) — Manager Channel',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(managerInstructionsPlaceholder),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('radio', {
        name: 'Group suggestions and post them in different channels',
      }),
    ).not.toBeInTheDocument();
  });
});
