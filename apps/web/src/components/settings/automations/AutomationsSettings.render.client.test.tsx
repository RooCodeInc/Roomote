import type { ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FeatureFlag } from '@roomote/feature-flags';

const groupedRoutingPlaceholder =
  /Ideas about incidents, reliability, alerts, and monitoring/;
const managerInstructionsPlaceholder =
  /Optional guidance for which ideas to prioritize or avoid/;

const state = vi.hoisted(() => ({
  featureFlags: {} as Partial<Record<FeatureFlag, boolean>>,
  nextUpdateSettingsResult: null as {
    success: true;
    settings: Record<string, unknown>;
    suggesterRoutingPreview: Array<{
      groupLabel: string;
      slackChannelName: string;
      guidance: string;
    }> | null;
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
        channelAutoStartSlackChannels: [
          {
            channelId: 'C123BUGS',
            instructions: 'Treat each message as a bug report.',
            launchMode: 'always_start' as const,
          },
        ],
        channelAutoStartDiscordChannels: [],
        managerSlackChannelId: 'C123MANAGER',
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
        suggesterRoutingMode: 'manager_channel' as const,
        suggesterRoutingInstructions: null,
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
      return { isPending: false, data: [] };
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
        return { isPending: false, data: [] };
      }
    }

    return state.settingsQuery;
  },
  useMutation: (_options?: {
    onSuccess?: (
      result: NonNullable<typeof state.nextUpdateSettingsResult>,
    ) => void;
    onError?: (...args: unknown[]) => void;
  }) => {
    return {
      isPending: false,
      mutate: vi.fn((variables: unknown) => {
        mutations.updateSettings(variables);
      }),
    };
  },
  useQueryClient: () => queryClient,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    featureFlags: state.featureFlags,
  }),
}));

vi.mock('@/hooks/useShowDebugUI', () => ({
  useShowDebugUI: () => ({ isDebugUIVisible: false }),
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
  }),
}));

import { AutomationsSettings } from './AutomationsSettings';

async function openSuggesterCard() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand Suggest Ideas' }),
  );
}

async function openReviewerCard() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand Review Code' }),
  );
}

describe('AutomationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.featureFlags = {};
    state.nextUpdateSettingsResult = null;
    mutations.latestSettingsOptions = null;
    mutations.latestTriggerOptions = null;
    state.settingsQuery.data.capabilities.discordConnected = false;
    state.discordChannelsQuery.data.channels = [];
    state.settingsQuery.data.settings.managerStatsDiscordChannelId = null;
    state.settingsQuery.data.settings.suggesterDiscordChannelId = null;
    state.settingsQuery.data.settings.announcerDiscordChannelId = null;
    state.settingsQuery.data.settings.platformIssueDiscordChannelId = null;
    state.settingsQuery.data.settings.managerSlackChannelId = 'C123MANAGER';
    state.settingsQuery.data.settings.managerStatsFrequency = 'off' as never;
    state.settingsQuery.data.settings.sentryTriageFrequency = 'off' as never;
    state.settingsQuery.data.settings.dependabotTriageFrequency =
      'off' as never;
    state.settingsQuery.data.settings.suggesterFrequency = 'off';
    state.settingsQuery.data.settings.suggesterInstructions = null;
    state.settingsQuery.data.settings.suggesterRoutingMode =
      'manager_channel' as const;
    state.settingsQuery.data.settings.suggesterRoutingInstructions = null;
    state.settingsQuery.data.reviewer.enabled = false;
    state.settingsQuery.data.reviewer.reviewAllPullRequestAuthors = false;
    state.settingsQuery.data.settings.reviewer.reviewAllPullRequestAuthors = false;
    state.settingsQuery.data.reviewer.reviewOnCommit = true;
    state.settingsQuery.data.reviewer.reviewDraftPrs = true;
    state.settingsQuery.data.reviewer.relayReviewResultsToTask = false;
    state.settingsQuery.data.reviewer.relayUsers = [];
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

  it('shows per-automation Slack destinations without requiring a manager channel', async () => {
    state.featureFlags = {};
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
        name: 'Expand Weekly Manager Stats',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand Triage Sentry Issues' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand Triage Dependabot Alerts' }),
    );

    expect(
      screen.getByLabelText('Post summaries to this Slack channel'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText('Post follow-up work to this Slack channel')
        .length,
    ).toBeGreaterThan(1);
    expect(
      screen.getAllByText('Select a Slack channel').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Reports to: not configured — set a Manager Channel.')
        .length,
    ).toBeGreaterThan(1);
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
        name: 'Expand Weekly Manager Stats',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand Triage Sentry Issues' }),
    );

    // The saved Discord channel is the selected destination.
    expect(
      screen.getByText('#automation-reports (Discord)'),
    ).toBeInTheDocument();
    // Pickers without a saved value use the provider-neutral placeholder.
    expect(screen.getAllByText('Select a channel').length).toBeGreaterThan(0);
    expect(
      screen.queryByText('Select a Slack channel'),
    ).not.toBeInTheDocument();
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
        name: 'Expand Alert on Config Errors',
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
      name: 'Expand Auto-respond to channels',
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

  it('shows exception-only capability badges from the shared descriptors', async () => {
    render(<AutomationsSettings />);

    // Dependabot and CodeQL stay GitHub-only; CI failure triage supports
    // GitHub/GitLab, Issue Fixer supports GitHub/GitLab/Gitea, and manager
    // stats is provider-neutral now and shows no source-control badge.
    expect((await screen.findAllByText('GitHub only')).length).toBe(2);
    // Full chat coverage for the suggester (no limited-comms badge); the other
    // manager automations already cover all communication providers.
    expect(screen.queryByText('Slack only')).toBeNull();
    expect(screen.queryByText('Slack · Discord · Telegram only')).toBeNull();
    expect(screen.queryByText(/Telegram only$/)).toBeNull();
    // conflict_resolver supports GitHub, GitLab, and Azure DevOps (no
    // Gitea/Bitbucket conflict signal).
    expect(
      screen.getAllByText('GitHub · GitLab · Azure DevOps only').length,
    ).toBe(1);
    // Full coverage shows nothing — absence of a warning is the signal.
    expect(screen.queryByText('All chat channels')).toBeNull();
    expect(screen.queryByText('All source control')).toBeNull();
  });

  it('renders the Source Code and Meta automation sections', async () => {
    render(<AutomationsSettings />);

    expect(
      await screen.findByText('Source Code automations'),
    ).toBeInTheDocument();
    expect(screen.getByText('Meta automations')).toBeInTheDocument();
    expect(screen.queryByText('Other automations')).toBeNull();
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

  it('shows grouped suggester routing controls when the feature flag is enabled', async () => {
    state.featureFlags = {
      [FeatureFlag.SuggestionRouting]: true,
    };
    state.settingsQuery.data.settings.suggesterFrequency = 'daily' as never;

    render(<AutomationsSettings />);
    await openSuggesterCard();

    expect(
      screen.getByRole('radio', {
        name: 'Post all suggestions to the manager channel',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', {
        name: 'Group suggestions and post them in different channels',
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Group suggestions and post them in different channels',
      }),
    );

    expect(
      screen.getByText(
        'Describe how to group ideas (eg by type, repo, module) and in what Slack channel to post them',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(groupedRoutingPlaceholder),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(managerInstructionsPlaceholder),
    ).not.toBeInTheDocument();
  });

  it('shows the grouped routing preview after save and restores editing on demand', async () => {
    state.featureFlags = {
      [FeatureFlag.SuggestionRouting]: true,
    };
    state.settingsQuery.data.settings.suggesterFrequency = 'daily' as never;
    state.settingsQuery.data.settings.suggesterRoutingMode =
      'group_by_instructions' as never;
    state.settingsQuery.data.settings.suggesterRoutingInstructions =
      'Incidents -> #eng-infra' as never;
    state.nextUpdateSettingsResult = {
      success: true,
      settings: {
        ...state.settingsQuery.data.settings,
        suggesterFrequency: 'daily',
        suggesterRoutingMode: 'group_by_instructions' as const,
        suggesterRoutingInstructions:
          'Incidents, alerts, and reliability ideas -> #eng-infra',
      },
      suggesterRoutingPreview: [
        {
          groupLabel: 'Incidents',
          slackChannelName: '#eng-infra',
          guidance: 'Alerts, outages, and reliability follow-up work.',
        },
      ],
      reviewer: state.settingsQuery.data.reviewer,
      slackChannelAccessWarnings:
        state.settingsQuery.data.slackChannelAccessWarnings,
      slackChannelDisplayNames:
        state.settingsQuery.data.slackChannelDisplayNames,
    };

    render(<AutomationsSettings />);
    await openSuggesterCard();

    const textarea = screen.getByPlaceholderText(groupedRoutingPlaceholder);
    fireEvent.change(textarea, {
      target: {
        value: 'Incidents, alerts, and reliability ideas -> #eng-infra',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(mutations.updateSettings).toHaveBeenCalled();
      expect(mutations.latestSettingsOptions?.onSuccess).toBeDefined();
    });
    await act(async () => {
      mutations.latestSettingsOptions?.onSuccess?.(
        state.nextUpdateSettingsResult!,
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Group')).toBeInTheDocument();
    });
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText('Incidents')).toBeInTheDocument();
    expect(screen.getByText('#eng-infra')).toBeInTheDocument();
    expect(
      screen.getByText('Alerts, outages, and reliability follow-up work.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(groupedRoutingPlaceholder),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() => {
      expect(screen.queryByText('Group')).not.toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText(groupedRoutingPlaceholder),
    ).toBeInTheDocument();
  });
});
