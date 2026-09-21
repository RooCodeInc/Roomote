import type { ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
const managerInstructionsPlaceholder =
  /Optional guidance for which ideas to prioritize or avoid/;

const state = vi.hoisted(() => ({
  latestScheduleOptions: null as {
    onSuccess: (
      result: { status: 'ambiguous'; clarification: string },
      variables: { schedule: string },
    ) => void;
  } | null,
  isAdmin: true,
  catalogQueryOptions: [] as Array<{ enabled?: boolean }>,
  queriedKeys: [] as unknown[],
  customAutomationsPending: false,
  customAutomationsError: false,
  customAutomationsFetching: false,
  customAutomationsLoaded: true,
  customAutomationsRefetch: vi.fn(),
  customAutomationRunPendingId: null as string | null,
  customAutomationTimeZone: 'UTC' as string | undefined,
  customAutomationDefaultTarget: undefined as
    | {
        provider: 'slack' | 'discord' | 'teams' | 'telegram' | 'email';
        targetKind: string;
        externalRef: string;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
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
      provider?: 'slack' | 'discord' | 'teams' | 'telegram' | 'email';
      externalRef?: string;
      targetKind?:
        | 'slack_channel'
        | 'slack_user'
        | 'discord_channel'
        | 'discord_user'
        | 'teams_channel'
        | 'teams_user'
        | 'telegram_chat'
        | 'telegram_user'
        | 'email_user';
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
    nextRunAt?: Date | null;
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
        emailConnected: true,
        requiresSlackReconnect: false,
        missingScopes: [],
        slackWorkspaceDomain: 'acme',
        sentryConnected: false,
      },
      emailIdentities: [
        {
          id: 'verified:user-admin:account',
          emailAddress: 'admin@example.com',
        },
      ],
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
        channelAutoStartEnabled: true,
        channelAutoStartDiscordChannels: [],
        managerSlackChannelId: 'C123MANAGER',
        managerDiscordChannelId: null as string | null,
        defaultAutomationTarget: {
          provider: 'slack' as const,
          targetKind: 'slack_channel' as const,
          externalRef: 'C123MANAGER',
        },
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
    onSuccess?: (
      result:
        | { outcome: 'launched'; taskId: string }
        | { outcome: 'queued' }
        | { outcome: 'completed' }
        | { outcome: 'skipped'; reason: string }
        | { outcome: 'failed'; error: string },
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
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (queryOptions: { queryKey?: unknown[] }) => {
    state.queriedKeys.push(queryOptions.queryKey);
    const key1 = queryOptions.queryKey?.[1];
    if (key1 === 'getCustomAutomationOptions') {
      const managerSlackChannelId =
        state.settingsQuery.data.settings.managerSlackChannelId;
      const managerDiscordChannelId =
        state.settingsQuery.data.settings.managerDiscordChannelId;
      return {
        isPending: state.settingsQuery.isPending,
        data: {
          capabilities: state.settingsQuery.data.capabilities,
          managerSlackChannelId,
          managerDiscordChannelId,
          emailIdentities: state.settingsQuery.data.emailIdentities,
          defaultTarget:
            state.customAutomationDefaultTarget !== undefined
              ? state.customAutomationDefaultTarget
              : managerSlackChannelId &&
                  state.settingsQuery.data.capabilities.slackConnected
                ? {
                    provider: 'slack',
                    targetKind: 'slack_channel',
                    externalRef: managerSlackChannelId,
                  }
                : managerDiscordChannelId &&
                    state.settingsQuery.data.capabilities.discordConnected
                  ? {
                      provider: 'discord',
                      targetKind: 'discord_channel',
                      externalRef: managerDiscordChannelId,
                    }
                  : null,
          effectiveTimeZone: state.customAutomationTimeZone,
        },
      };
    }
    if (key1 === 'listSlackChannels' || key1 === 'listDiscordChannels') {
      return key1 === 'listSlackChannels'
        ? state.slackChannelsQuery
        : state.discordChannelsQuery;
    }

    if (key1 === 'listCustomAutomations') {
      return {
        isPending: state.customAutomationsPending,
        isError: state.customAutomationsError,
        isFetching: state.customAutomationsFetching,
        data: state.customAutomationsLoaded
          ? state.customAutomations
          : undefined,
        refetch: state.customAutomationsRefetch,
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

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    automations: {
      getCustomAutomationOptions: {
        queryOptions: () => ({
          queryKey: ['automations', 'getCustomAutomationOptions'],
        }),
      },
      getSettings: {
        queryOptions: () => ({
          queryKey: ['automations', 'getSettings'],
        }),
        queryKey: () => ['automations', 'getSettings'],
      },
      listSlackChannels: {
        queryOptions: (
          _input: undefined,
          options: { enabled?: boolean } = {},
        ) => {
          state.catalogQueryOptions.push(options);
          return { queryKey: ['automations', 'listSlackChannels'], ...options };
        },
      },
      listDiscordChannels: {
        queryOptions: (
          _input: undefined,
          options: { enabled?: boolean } = {},
        ) => {
          state.catalogQueryOptions.push(options);
          return {
            queryKey: ['automations', 'listDiscordChannels'],
            ...options,
          };
        },
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
        mutationOptions: (options?: Record<string, unknown>) => {
          state.latestScheduleOptions =
            options as typeof state.latestScheduleOptions;
          return options ?? {};
        },
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
import {
  CustomAutomationsSection,
  nextRunLabel,
} from './CustomAutomationsSection';

it.each([false, true])(
  'enables custom-editor channel catalogs only for admins (isAdmin=%s)',
  (isAdmin) => {
    state.isAdmin = isAdmin;
    state.catalogQueryOptions = [];
    try {
      render(<CustomAutomationsSection />);
      expect(state.catalogQueryOptions.length).toBeGreaterThanOrEqual(2);
      expect(
        state.catalogQueryOptions.every(
          (options) => options.enabled === isAdmin,
        ),
      ).toBe(true);
    } finally {
      state.isAdmin = true;
    }
  },
);

it('opens the standalone custom editor without querying admin settings', () => {
  state.queriedKeys = [];
  render(<CustomAutomationsSection />);

  expect(
    screen.queryByRole('radio', { name: 'Built-in' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText('No custom automations created yet.'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  expect(state.queriedKeys).toContainEqual([
    'automations',
    'getCustomAutomationOptions',
  ]);
  expect(state.queriedKeys).not.toContainEqual(['automations', 'getSettings']);
  expect(state.queriedKeys).not.toContainEqual(['miscSettings', 'get']);
  expect(state.queriedKeys).not.toContainEqual(['comms', 'status']);
});

it('validates required custom automation fields before creating', () => {
  render(<CustomAutomationsSection />);
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(
    screen.getByRole('combobox', { name: 'Preferred environment' }),
  );
  fireEvent.click(screen.getByRole('option', { name: 'Let Roomote decide' }));

  const name = screen.getByRole('textbox', { name: 'Name' });
  const prompt = screen.getByRole('textbox', { name: 'Prompt' });
  fireEvent.change(name, { target: { value: '   ' } });
  fireEvent.change(prompt, { target: { value: '\n ' } });
  mutations.updateSettings.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  expect(mutations.updateSettings).not.toHaveBeenCalled();
  expect(name).toHaveFocus();
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(name).toHaveAccessibleDescription('Enter a name.');
  expect(prompt).toHaveAttribute('aria-invalid', 'true');
  expect(prompt).toHaveAccessibleDescription('Enter a prompt.');
  expect(screen.getByText('Enter a name.')).toHaveAttribute('role', 'alert');
  expect(screen.getByText('Enter a prompt.')).toHaveAttribute('role', 'alert');

  fireEvent.change(name, { target: { value: 'Local validation proof' } });
  expect(name).not.toHaveAttribute('aria-invalid');
  expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
  expect(prompt).toHaveAttribute('aria-invalid', 'true');

  fireEvent.change(prompt, {
    target: { value: 'Verify required-field validation.' },
  });
  expect(prompt).not.toHaveAttribute('aria-invalid');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(mutations.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Local validation proof',
      prompt: 'Verify required-field validation.',
      environmentId: '__fast__',
    }),
  );
});

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

function setRunnableCustomAutomation() {
  state.customAutomations = [
    {
      id: 'automation-1',
      name: 'Daily scan',
      prompt: 'Find flaky tests.',
      enabled: true,
      scheduleMode: 'daily',
      cronExpression: null,
      model: null,
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
    },
  ];
}

describe('AutomationsSettings', () => {
  beforeEach(() => {
    vi.useRealTimers();
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
    state.settingsQuery.data.capabilities.emailConnected = true;
    state.settingsQuery.data.emailIdentities = [
      {
        id: 'verified:user-admin:account',
        emailAddress: 'admin@example.com',
      },
    ];
    delete (state.settingsQuery.data.settings as Record<string, unknown>)
      .managerStatsEmailIdentityId;
    state.discordChannelsQuery.data.channels = [];
    state.settingsQuery.data.settings.managerStatsDiscordChannelId = null;
    state.settingsQuery.data.settings.suggesterDiscordChannelId = null;
    state.settingsQuery.data.settings.announcerDiscordChannelId = null;
    state.settingsQuery.data.settings.platformIssueDiscordChannelId = null;
    state.settingsQuery.data.settings.managerSlackChannelId = 'C123MANAGER';
    state.settingsQuery.data.settings.defaultAutomationTarget = {
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: 'C123MANAGER',
    };
    state.settingsQuery.data.slackChannelDisplayNames.managerSlackChannel =
      '#roomote-managers';
    state.settingsQuery.data.settings.managerDiscordChannelId = null;
    state.settingsQuery.data.settings.managerStatsFrequency = 'off' as never;
    state.settingsQuery.data.settings.channelAutoStartEnabled = true;
    state.settingsQuery.data.settings.mergeAnnouncerFrequency = 'off';
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
    state.customAutomationTimeZone = 'UTC';
    state.customAutomationDefaultTarget = undefined;
    state.customAutomationsPending = false;
    state.customAutomationsError = false;
    state.customAutomationsFetching = false;
    state.customAutomationsLoaded = true;
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
      await screen.findByRole('switch', {
        name: /(?:Enable|Disable) Weekly Manager Stats/,
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
      screen.getByLabelText('Post alerts to this destination'),
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
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;
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
      screen.getByLabelText('Post summaries to this destination'),
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
      screen.getByLabelText('Post follow-up work to this destination'),
    ).toBeInTheDocument();
    closeAutomationDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: /(?:Set up|Configure) Triage Dependabot Alerts/,
      }),
    );

    expect(
      screen.getByLabelText('Post follow-up work to this destination'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Default');
    expect(
      screen.getByText('Reports to: not configured — set a Manager Channel.'),
    ).toBeInTheDocument();
  });

  it('keeps Suggest Ideas and Summarize Merged PRs setup available without a default destination', async () => {
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;
    state.settingsQuery.data.resolvedDestinations.suggester = null;
    state.settingsQuery.data.resolvedDestinations.announcer = null;

    render(<AutomationsSettings />);

    const suggesterSwitch = await screen.findByRole('switch', {
      name: 'Enable Suggest Ideas',
    });
    const announcerSwitch = screen.getByRole('switch', {
      name: 'Enable Summarize Merged PRs',
    });
    expect(suggesterSwitch).toBeEnabled();
    expect(announcerSwitch).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Set up Suggest Ideas' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Set up Summarize Merged PRs' }),
    ).toBeEnabled();

    fireEvent.click(suggesterSwitch);
    expect(
      await screen.findByRole('dialog', { name: 'Suggest Ideas' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toBeInTheDocument();
    closeAutomationDialog();

    fireEvent.click(announcerSwitch);
    expect(
      await screen.findByRole('dialog', { name: 'Summarize Merged PRs' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toBeInTheDocument();
  });

  it('loads a built-in Email destination in the shared picker', async () => {
    state.settingsQuery.data.settings.managerStatsFrequency = 'weekly' as never;
    (
      state.settingsQuery.data.settings as Record<string, unknown>
    ).managerStatsEmailIdentityId = 'verified:user-admin:account';

    render(<AutomationsSettings />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: /(?:Set up|Configure) Weekly Manager Stats/,
      }),
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Email');
    expect(
      screen.getByRole('combobox', { name: 'Email address' }),
    ).toHaveTextContent('admin@example.com · Account email');
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
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Discord');
    expect(
      screen.getByRole('combobox', { name: 'Destination channel' }),
    ).toBeInTheDocument();
    closeAutomationDialog();
    fireEvent.click(
      screen.getByRole('button', {
        name: /(?:Set up|Configure) Triage Sentry Issues/,
      }),
    );

    // Pickers without an explicit value show the standard destination.
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Default');
    expect(
      screen.queryByRole('combobox', { name: 'Destination channel' }),
    ).not.toBeInTheDocument();
  });

  it('shows Discord as the shared manager destination', async () => {
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;
    state.settingsQuery.data.settings.managerDiscordChannelId =
      '111222333444555666';
    state.settingsQuery.data.settings.defaultAutomationTarget = {
      provider: 'discord',
      targetKind: 'discord_channel',
      externalRef: '111222333444555666',
    } as never;
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

    expect(await screen.findByText('#automation-reports')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Discord');
    expect(
      screen.getByRole('combobox', { name: 'Destination channel' }),
    ).toHaveTextContent('#automation-reports');
    expect(
      screen.queryByRole('button', {
        name: /(?:Set up|Configure) Automation output/,
      }),
    ).not.toBeInTheDocument();
  });

  it('shows an explicit unconfigured state instead of an automatic destination', async () => {
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.managerDiscordChannelId = null;
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;

    render(<AutomationsSettings />);

    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
    expect(screen.queryByText(/Automatic · Shared/)).not.toBeInTheDocument();
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
      screen.getByLabelText('Post alerts to this destination'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Discord');
    expect(
      screen.getByRole('combobox', { name: 'Destination channel' }),
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

  it('offers the shared run-now action for installed release announcements', async () => {
    render(<AutomationsSettings />);

    expect(
      await screen.findByRole('button', {
        name: 'Run Announce Roomote Updates now',
      }),
    ).toBeEnabled();
  });

  it('shows provider support as plain text instead of badges', async () => {
    render(<AutomationsSettings />);

    await screen.findByText('Triage Dependabot Alerts');
    const dependabotRow = screen
      .getByText('Triage Dependabot Alerts')
      .closest('[role="row"]');
    expect(dependabotRow).not.toBeNull();
    const providerSupport = within(dependabotRow as HTMLElement).getByText(
      /GitHub only/,
    );
    expect(providerSupport.tagName).toBe('SPAN');
  });

  it('renders custom and built-in automations in one list by default', async () => {
    render(<AutomationsSettings />);

    expect(
      await screen.findByRole('table', { name: 'Automations' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    expect(screen.getByText('Auto-respond to channels')).toBeInTheDocument();
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
  });

  it('orders the unified list alphabetically without changing query data', async () => {
    state.customAutomations = [
      {
        id: 'automation-z',
        name: 'Zulu custom automation',
        prompt: 'Run last alphabetically.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
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
      },
      {
        id: 'automation-a',
        name: 'Aardvark custom automation',
        prompt: 'Run first alphabetically.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
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
      },
    ];

    render(<AutomationsSettings />);

    await screen.findByText('Aardvark custom automation');
    const orderedRows = screen
      .getAllByRole('row')
      .map((row) => row.textContent ?? '');

    expect(orderedRows[0]).toContain('Aardvark custom automation');
    expect(orderedRows[1]).toContain('Alert on Config Errors');
    expect(orderedRows.at(-1)).toContain('Zulu custom automation');
    expect(
      state.customAutomations.map((automation) => automation.name),
    ).toEqual(['Zulu custom automation', 'Aardvark custom automation']);

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Search automations' }),
      { target: { value: 'Run first alphabetically' } },
    );
    const customRow = screen
      .getByText('Aardvark custom automation')
      .closest('[role="row"]');
    expect(customRow?.nextElementSibling).toBe(
      screen.getByText('No built-in automations match your search.'),
    );
  });

  it('uses built-in switches only for direct enablement changes', async () => {
    render(<AutomationsSettings />);

    const enabledSwitch = await screen.findByRole('switch', {
      name: 'Disable Auto-respond to channels',
    });
    expect(enabledSwitch).toBeChecked();
    expect(enabledSwitch).toHaveAttribute('data-state', 'checked');
    const disabledSwitch = screen.getByRole('switch', {
      name: 'Enable CI Failure Triage',
    });
    expect(disabledSwitch).not.toBeChecked();
    expect(disabledSwitch).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(enabledSwitch);
    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        savingAutomation: 'channelAutoStart',
        channelAutoStartEnabled: false,
        channelAutoStartSlackChannels: [
          expect.objectContaining({ channelId: 'C123BUGS' }),
        ],
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Auto-respond to channels' }),
    ).not.toBeInTheDocument();
  });

  it('requires confirmation before enabling a schedule-backed automation', async () => {
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'Enable Resolve PR Conflicts',
      }),
    );

    expect(mutations.updateSettings).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: 'Resolve PR Conflicts' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Resolve PR Conflicts schedule' }),
    ).toHaveTextContent('Every hour');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.getByRole('switch', { name: 'Enable Resolve PR Conflicts' }),
    ).not.toBeChecked();
    expect(mutations.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Enable Resolve PR Conflicts' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        savingAutomation: 'conflictResolver',
        conflictResolverFrequency: 'every_hour',
      }),
    );
  });

  it('requires confirmation before enabling a scheduled custom automation', async () => {
    setRunnableCustomAutomation();
    state.customAutomations[0]!.enabled = false;
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Toggle Daily scan' }),
    );

    expect(
      screen.getByRole('dialog', { name: 'Edit custom automation' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Schedule' }),
    ).toHaveTextContent('Daily');
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    expect(mutations.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('switch', { name: 'Toggle Daily scan' }),
    ).not.toBeChecked();
    expect(mutations.updateSettings).not.toHaveBeenCalled();
  });

  it('preserves the resolver clarification after another submission', async () => {
    render(<CustomAutomationsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Review' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Review prompt' },
    });
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Preferred environment' }),
    );
    fireEvent.click(screen.getByRole('option', { name: 'Let Roomote decide' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom schedule' }));
    const input = screen.getByRole('textbox', { name: 'Custom schedule' });
    fireEvent.change(input, { target: { value: 'Every weekday' } });
    await act(async () =>
      state.latestScheduleOptions!.onSuccess(
        { status: 'ambiguous', clarification: 'What time on weekdays?' },
        { schedule: 'Every weekday' },
      ),
    );
    expect(screen.getByText('What time on weekdays?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('What time on weekdays?')).toBeVisible();
  });

  it('focuses and describes an invalid custom schedule before creating', () => {
    render(<CustomAutomationsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Schedule validation' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Verify custom schedule recovery.' },
    });
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Preferred environment' }),
    );
    fireEvent.click(screen.getByRole('option', { name: 'Let Roomote decide' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom schedule' }));

    const schedule = screen.getByRole('textbox', { name: 'Custom schedule' });
    mutations.updateSettings.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mutations.updateSettings).not.toHaveBeenCalled();
    expect(schedule).toHaveFocus();
    expect(schedule).toHaveAttribute('aria-invalid', 'true');
    expect(schedule).toHaveAccessibleDescription(
      'Enter a valid schedule first.',
    );
    expect(screen.getByText('Enter a valid schedule first.')).toHaveAttribute(
      'role',
      'alert',
    );

    fireEvent.change(schedule, { target: { value: '0 9 * * 1-5' } });
    expect(schedule).not.toHaveAttribute('aria-invalid');
    expect(
      screen.queryByText('Enter a valid schedule first.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('At 09:00 AM, Monday through Friday (UTC)'),
    ).toBeInTheDocument();
  });

  it('uses the same invalid custom schedule recovery while editing', async () => {
    setRunnableCustomAutomation();
    render(<AutomationsSettings />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Configure Daily scan' }),
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom schedule' }));

    const schedule = screen.getByRole('textbox', { name: 'Custom schedule' });
    mutations.updateSettings.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutations.updateSettings).not.toHaveBeenCalled();
    expect(schedule).toHaveFocus();
    expect(schedule).toHaveAccessibleDescription(
      'Enter a valid schedule first.',
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Daily' }));
    expect(
      screen.queryByText('Enter a valid schedule first.'),
    ).not.toBeInTheDocument();
  });

  it('disables a scheduled automation directly', async () => {
    state.settingsQuery.data.settings.managerStatsFrequency = 'weekly' as never;
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'Disable Weekly Manager Stats',
      }),
    );

    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        savingAutomation: 'managerStats',
        managerStatsFrequency: 'off',
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Weekly Manager Stats' }),
    ).not.toBeInTheDocument();
  });

  it('enables webhook automations with their boolean sentinel, not a periodic schedule', async () => {
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Enable Merge announcer' }),
    );

    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        savingAutomation: 'mergeAnnouncer',
        mergeAnnouncerFrequency: 'daily',
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Merge announcer' }),
    ).not.toBeInTheDocument();
  });

  it('updates custom enablement without changing its configuration', async () => {
    setRunnableCustomAutomation();
    render(<AutomationsSettings />);

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Toggle Daily scan' }),
    );

    expect(mutations.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'automation-1',
        enabled: false,
        name: 'Daily scan',
        prompt: 'Find flaky tests.',
        scheduleMode: 'daily',
      }),
    );
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

  it('filters the unified list by type and searches built-in summaries', async () => {
    render(<AutomationsSettings />);

    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Search automations' }),
      { target: { value: 'Pull request events' } },
    );
    expect(screen.getByText('Review Code')).toBeInTheDocument();
    expect(
      screen.queryByText('Auto-respond to channels'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.queryByText('Review Code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Built-in' }));
    expect(screen.getByText('Review Code')).toBeInTheDocument();
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
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;
    state.settingsQuery.data.slackChannelDisplayNames.managerSlackChannel =
      null as never;

    render(<AutomationsSettings />);

    expect(
      screen.queryByText('No built-in automations enabled yet.'),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('switch', {
        name: 'Disable Alert on Config Errors',
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const customEmptyState = await screen.findByText(
      'No custom automations created yet.',
    );
    expect(customEmptyState.tagName).toBe('P');
    expect(customEmptyState).toHaveClass('text-sm', 'text-muted-foreground');
  });

  it('retries an initial custom automation load failure and recovers in place', async () => {
    state.customAutomationsLoaded = false;
    state.customAutomationsError = true;

    const { rerender } = render(<AutomationsSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));

    expect(
      screen.getByText('Failed to load custom automations.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No custom automations created yet.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.customAutomationsRefetch).toHaveBeenCalledTimes(1);

    state.customAutomationsFetching = true;
    rerender(<AutomationsSettings />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();

    state.customAutomationsFetching = false;
    rerender(<AutomationsSettings />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();

    state.customAutomationsError = false;
    state.customAutomationsLoaded = true;
    state.customAutomations = [];
    rerender(<AutomationsSettings />);
    expect(
      screen.getByText('No custom automations created yet.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load custom automations.'),
    ).not.toBeInTheDocument();
  });

  it('keeps cached custom automations visible after a refetch failure', () => {
    state.customAutomationsError = true;
    state.customAutomations = [
      {
        id: 'automation-cached',
        name: 'Cached automation',
        prompt: 'Keep showing this automation.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
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
      },
    ];

    render(<AutomationsSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));

    expect(screen.getByText('Cached automation')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load custom automations.'),
    ).not.toBeInTheDocument();
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
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['automations', 'listCustomAutomations'],
    });

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

  it.each([
    { outcome: 'completed' as const },
    { outcome: 'failed' as const, error: 'launch failed' },
  ])('refreshes persisted custom automation state after $outcome', (result) => {
    setRunnableCustomAutomation();
    render(<AutomationsSettings />);

    act(() => {
      mutations.latestCustomTriggerOptions?.onSuccess?.(result);
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['automations', 'listCustomAutomations'],
    });
  });

  it.each([
    { outcome: 'launched' as const, taskId: 'task-custom-1' },
    { outcome: 'queued' as const },
  ])('uses bounded follow-up refreshes after $outcome', (result) => {
    vi.useFakeTimers();
    setRunnableCustomAutomation();
    const { unmount } = render(<AutomationsSettings />);

    try {
      act(() => {
        mutations.latestCustomTriggerOptions?.onSuccess?.(result);
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();

      act(() => {
        vi.runAllTimers();
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(8);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('does not schedule follow-up refreshes after unmount', () => {
    vi.useFakeTimers();
    setRunnableCustomAutomation();
    const { unmount } = render(<AutomationsSettings />);
    const onSuccess = mutations.latestCustomTriggerOptions?.onSuccess;

    try {
      unmount();
      act(() => {
        onSuccess?.({ outcome: 'queued' });
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();

      act(() => {
        vi.runAllTimers();
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Preferred environment' }),
    );
    expect(
      screen.getByRole('option', { name: 'All repositories' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Blank slate' }),
    ).toBeInTheDocument();
  });

  it('offers no preference in the environment menu and explains channel-less output', async () => {
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

    expect(await screen.findByText('Daily →')).toBeInTheDocument();
    const search = screen.getByRole('textbox', { name: 'Search automations' });
    fireEvent.change(search, {
      target: { value: 'Summarize priorities' },
    });
    expect(screen.getByText('Fast daily digest')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'No matching automation' } });
    expect(screen.queryByText('Fast daily digest')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
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
        'Each run is a session in the web app and does not send a report.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Preferred environment' }),
    );
    expect(
      screen.getByRole('option', { name: 'Let Roomote decide' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Let Roomote decide' }));
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
        nextRunAt: new Date('2026-09-11T13:00:00Z'),
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
        'At 09:00 AM, Monday through Friday (UTC), in Production →',
      ),
    ).toBeInTheDocument();
    const creatorMetadata = screen.getByText(/Created by Ada/, {
      selector: 'span',
    });
    expect(creatorMetadata).toHaveTextContent(
      /Created by Ada · Last run \d+s ago/,
    );
    expect(creatorMetadata).not.toHaveTextContent('Next run');
    expect(screen.getByText('Next run Sep 11 at 1:00 PM')).toHaveClass(
      'basis-full',
    );
    expect(screen.getByText('Next run Sep 11 at 1:00 PM')).toHaveAttribute(
      'title',
      '2026-09-11T13:00:00.000Z',
    );
    expect(screen.queryByText('0 9 * * 1-5')).not.toBeInTheDocument();
  });

  it('includes the year only when the next run is outside the current year', () => {
    const now = new Date('2026-09-11T12:00:00Z');
    expect(nextRunLabel('2026-12-31T15:00:00Z', 'UTC', now)).toBe(
      'Next run Dec 31 at 3:00 PM',
    );
    expect(nextRunLabel('2027-01-01T15:00:00Z', 'UTC', now)).toBe(
      'Next run Jan 1, 2027 at 3:00 PM',
    );
  });

  it('shows saved cron cadence in the deployment timezone', async () => {
    state.customAutomationTimeZone = 'America/New_York';
    state.environments = [{ id: 'env-1', name: 'Production' }];
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Daily scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'cron',
        cronExpression: '0 9 * * *',
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

    expect(
      await screen.findByText(
        'Daily at 09:00 AM (America/New York), in Production →',
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Search automations' }),
      { target: { value: 'America/New York' } },
    );
    expect(screen.getByText('Daily scan')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Daily scan' }),
    );
    expect(
      screen.getByText('Daily at 09:00 AM (America/New York)'),
    ).toBeInTheDocument();
  });

  it.each([
    {
      reason: 'the deployment timezone is unavailable',
      timeZone: undefined,
      cronExpression: '0 9 * * *',
    },
    {
      reason: 'the saved cron is invalid',
      timeZone: 'UTC',
      cronExpression: '99 99 * * *',
    },
  ])('falls back when $reason', async ({ timeZone, cronExpression }) => {
    state.customAutomationTimeZone = timeZone;
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Daily scan',
        prompt: 'Find flaky tests.',
        enabled: true,
        scheduleMode: 'cron',
        cronExpression,
        model: null,
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
      },
    ];

    render(<AutomationsSettings />);

    expect(await screen.findByText('Custom schedule →')).toBeInTheDocument();
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
        'Each run is a session that reports findings and failures here, and replies continue it.',
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
        'Each run is a session that reports findings and failures here, and replies continue it.',
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
        'Each run is a session that reports findings and failures here, and replies continue it.',
      ),
    ).toBeInTheDocument();
  });

  it('explains that Telegram replies continue the Fast session', async () => {
    state.settingsQuery.data.capabilities.telegramConnected = true;
    state.customAutomations = [
      {
        id: 'automation-telegram-fast',
        name: 'Telegram daily brief',
        prompt: 'Summarize my priorities.',
        enabled: true,
        scheduleMode: 'daily',
        cronExpression: null,
        model: null,
        executionMode: 'fast',
        environmentId: '__fast__',
        target: {
          provider: 'telegram',
          targetKind: 'telegram_user',
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
        name: 'Configure Telegram daily brief',
      }),
    );

    expect(
      screen.getByText(
        'Each run is a session that reports findings and failures here, and replies continue it.',
      ),
    ).toBeInTheDocument();
  });

  it('only offers connected providers as custom automation destinations', async () => {
    state.settingsQuery.data.capabilities.slackConnected = false;
    state.settingsQuery.data.capabilities.discordConnected = true;
    state.settingsQuery.data.capabilities.teamsConnected = true;
    state.settingsQuery.data.settings.managerSlackChannelId = null as never;
    state.settingsQuery.data.settings.defaultAutomationTarget = null as never;
    state.customAutomationDefaultTarget = {
      provider: 'discord',
      targetKind: 'discord_user',
      externalRef: 'user-1',
    };

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
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Email' })).toBeInTheDocument();
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

  it('preserves a saved unavailable Email destination when capabilities finish loading', async () => {
    state.settingsQuery.isPending = true;
    state.customAutomations = [
      {
        id: 'automation-1',
        name: 'Weekly Email report',
        prompt: 'Summarize the week.',
        enabled: true,
        scheduleMode: 'weekly',
        cronExpression: null,
        model: null,
        environmentId: 'env-1',
        target: {
          provider: 'email',
          targetKind: 'email_user',
          externalRef: 'user-1',
          metadata: { emailIdentityId: 'verified:user-1:address-digest' },
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

    const { rerender } = render(<AutomationsSettings />);
    expect(await screen.findByText('Email me')).toBeInTheDocument();
    expect(screen.queryByText('Email DM me')).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Configure Weekly Email report',
      }),
    );
    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Email');

    state.settingsQuery.isPending = false;
    rerender(<AutomationsSettings />);

    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: 'Destination provider' }),
      ).toHaveTextContent('Email');
      expect(
        screen.getByRole('combobox', { name: 'Email address' }),
      ).toHaveTextContent('Email · No longer available');
    });
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
