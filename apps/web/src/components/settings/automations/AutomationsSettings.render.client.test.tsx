import type { ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
const managerInstructionsPlaceholder =
  /Optional guidance for which ideas to prioritize or avoid/;

const state = vi.hoisted(() => ({
  customAutomationsPending: false,
  customAutomations: [] as Array<{
    id: string;
    name: string;
    prompt: string;
    enabled: boolean;
    scheduleMode: 'weekly';
    cronExpression: null;
    model: null;
    environmentId: string;
    target: {
      provider: 'slack';
      externalRef: string;
      metadata?: Record<string, unknown>;
    };
    lastRunAt: null;
    lastSucceededAt: null;
    lastFailedAt: null;
    lastError: null;
    lastLaunchedTaskId: null;
    createdByName: string;
    createdAt: Date;
    updatedAt: Date;
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
          relayReviewResultsToTask: false,
          relayUsers: [],
        },
        conflictResolverFrequency: 'off' as const,
        conflictResolverMaxPrAgeDays: 7 as const,
        conflictResolverLabel: 'roomote:auto-resolve-conflicts',
        conflictResolverInstructions: null,
        reviewCodeInstructions: null as string | null,
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
      },
      slackChannelDisplayNames: {
        channelAutoStartSlackChannels: {
          C123BUGS: '#bugs',
        },
        managerSlackChannel: '#roomote-managers',
        managerStatsSlackChannel: null,
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
        relayReviewResultsToTask: false,
        relayUsers: [],
      },
      resolvedDestinations: Object.fromEntries(
        [
          'manager_stats',
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
      result: NonNullable<typeof state.nextUpdateSettingsResult>,
    ) => void;
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
      // environments.list and any leftover channel listszheimer
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
  }) => {
    return {
      isPending: false,
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
        mutationOptions: (options?: Record<string, unknown>) => ({
          ...options,
          mutationKind: 'triggerCustomAutomation',
        }),
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

import { AutomationsSettings } from './AutomationsSettings';

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
    mutations.latestSettingsOptions = null;
    mutations.latestTriggerOptions = null;
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

  it('uses plain text empty states for built-in and custom automations', async () => {
    state.settingsQuery.data.settings.channelAutoStartSlackChannels = [];
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.slackChannelDisplayNames.managerSlackChannel =
      null as never;

    render(<AutomationsSettings />);

    const builtInEmptyState = await screen.findByText(
      'No built-in automations enabled yet.',
    );
    expect(builtInEmptyState.tagName).toBe('P');
    expect(builtInEmptyState).toHaveClass('text-sm', 'text-muted-foreground');
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
    expect(
      screen.getByText(
        'Weekly · Production · slack:#roomote-managers · Created by Ada',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Run Weekly flaky-test scan now' }),
    );
    expect(mutations.triggerCustomAutomation).toHaveBeenCalledWith({
      id: 'automation-1',
    });
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

  it('preserves an existing destination while capabilities are loading', async () => {
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

    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Weekly flaky-test scan',
      }),
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Slack');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
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
