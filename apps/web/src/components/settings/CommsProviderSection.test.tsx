import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { CommsProviderSection } from './CommsProviderSection';

type CommsProviderStatus = {
  id: 'slack' | 'microsoft' | 'telegram';
  label: string;
  fields: Array<{
    envVarName: string;
    acceptedEnvVarNames: string[];
    label: string;
    required?: boolean;
    secret?: boolean;
    runtimeSatisfied: boolean;
    savedSatisfied: boolean;
    savedValue?: string | null;
    satisfiedByEnvVarName: string | null;
  }>;
  runtimeSatisfied: boolean;
  savedSatisfied: boolean;
  setupSatisfied: boolean;
  telegramWebhook?: {
    status:
      | 'connected'
      | 'mismatch'
      | 'stale_updates'
      | 'unregistered'
      | 'error';
    registeredUrl: string | null;
    expectedUrl: string;
    lastErrorMessage: string | null;
  } | null;
  telegramBotUsername?: string | null;
};

const state = vi.hoisted(() => ({
  slackInstallation: null as null | { teamName?: string },
  slackInstallationIsPending: false,
  connectSlackIsPending: false,
  disconnectSlackIsPending: false,
  connectSlackUrl: 'https://slack.com/install' as string | null,
  teamsStatus: {
    botConfigured: false,
    botUsesTenantSpecificTokenFlow: false,
    microsoftAuthConfigured: false,
    webhookUrl: 'https://roomote.dev/api/webhooks/teams',
    openInTeamsUrl: null as string | null,
    primaryConversationReady: false,
    primaryConversationType: null as string | null,
  } as null | {
    botConfigured: boolean;
    botUsesTenantSpecificTokenFlow: boolean;
    microsoftAuthConfigured: boolean;
    webhookUrl: string;
    openInTeamsUrl: string | null;
    primaryConversationReady: boolean;
    primaryConversationType: string | null;
  },
  teamsStatusIsPending: false,
  teamsStatusIsError: false,
  routerDebugSettings: {
    routerDebugSlackChannelId: null as string | null,
    envFallbackSlackChannelId: null as string | null,
    effectiveRouterDebugSlackChannelId: null as string | null,
    source: 'none' as 'deployment' | 'env' | 'none',
  },
  routerDebugIsPending: false,
  routerDebugIsError: false,
  slackChannels: [] as Array<{
    id: string;
    name: string;
    label: string;
    isPrivate: boolean;
    isMember: boolean;
  }>,
  slackChannelsIsPending: false,
  slackChannelsIsError: false,
  slackChannelsIsFetching: false,
  updateRouterDebugIsPending: false,
}));

const mutations = vi.hoisted(() => ({
  connectSlack: vi.fn(),
  disconnectSlack: vi.fn(),
  updateRouterDebug: vi.fn(),
  refetchSlackChannels: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: string[]; enabled?: boolean }) => {
    void options;
    if (options.queryKey?.[0] === 'routerDebug') {
      return {
        data: state.routerDebugSettings,
        isPending: state.routerDebugIsPending,
        isError: state.routerDebugIsError,
      };
    }
    if (options.queryKey?.[0] === 'automations') {
      return {
        data:
          options.enabled === false
            ? undefined
            : { channels: state.slackChannels },
        isPending: state.slackChannelsIsPending,
        isError: state.slackChannelsIsError,
        isFetching: state.slackChannelsIsFetching,
        refetch: mutations.refetchSlackChannels,
      };
    }
    return {
      data: undefined,
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useMutation: (options: {
    onSuccess?: (settings: unknown) => void;
    onError?: (error: Error) => void;
  }) => ({
    isPending: state.updateRouterDebugIsPending,
    mutate: (input: unknown) => {
      mutations.updateRouterDebug(input);
      options.onSuccess?.({
        routerDebugSlackChannelId:
          (input as { routerDebugSlackChannelId: string | null })
            .routerDebugSlackChannelId ?? null,
      });
    },
  }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/hooks/slack', () => ({
  useSlackInstallation: () => ({
    data: state.slackInstallation,
    isPending: state.slackInstallationIsPending,
  }),
  useConnectSlack: () => ({
    isPending: state.connectSlackIsPending,
    mutate: (
      _input: unknown,
      options?: { onSuccess?: (url: string) => void },
    ) => {
      mutations.connectSlack();
      if (state.connectSlackUrl) {
        options?.onSuccess?.(state.connectSlackUrl);
      }
    },
  }),
  useDisconnectSlack: () => ({
    isPending: state.disconnectSlackIsPending,
    mutate: (_input: unknown, options?: { onSuccess?: () => void }) => {
      mutations.disconnectSlack();
      options?.onSuccess?.();
    },
  }),
}));

vi.mock('@/hooks/teams', () => ({
  useTeamsIntegrationStatus: (_options?: { enabled?: boolean }) => ({
    data: state.teamsStatus,
    isPending: state.teamsStatusIsPending,
    isError: state.teamsStatusIsError,
  }),
}));

vi.mock('./TelegramLinkAccountStep', () => ({
  TelegramLinkAccountStep: () => <div>Telegram link step</div>,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    slack: {
      installation: { queryKey: () => ['slack', 'installation'] },
    },
    comms: {
      status: { queryKey: () => ['comms', 'status'] },
      repairTelegram: {
        mutationOptions: (options: unknown) => options,
      },
    },
    routerDebug: {
      getSettings: {
        queryKey: () => ['routerDebug', 'getSettings'],
        queryOptions: () => ({ queryKey: ['routerDebug', 'getSettings'] }),
      },
      updateSettings: {
        mutationOptions: (options: unknown) => options,
      },
    },
    automations: {
      listSlackChannels: {
        queryOptions: (
          _input?: undefined,
          options?: { enabled?: boolean },
        ) => ({
          queryKey: ['automations', 'listSlackChannels'],
          enabled: options?.enabled,
        }),
      },
    },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/components/system', () => ({
  ArrowLeft: () => <svg aria-hidden="true" />,
  BasicTooltip: ({ children }: { children: ReactNode }) => children,
  BrandIcon: ({ icon }: { icon: string }) => (
    <svg aria-label={icon} role="img" />
  ),
  Button: ({
    asChild,
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    children: ReactNode;
  }) => {
    if (asChild) {
      const child = children as ReactElement<
        AnchorHTMLAttributes<HTMLAnchorElement>
      >;

      return <a {...child.props}>{child.props.children}</a>;
    }

    return (
      <button type="button" {...props}>
        {children}
      </button>
    );
  },
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardAction: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  Check: () => <svg aria-hidden="true" />,
  CopyIconButton: ({
    'aria-label': ariaLabel,
  }: {
    'aria-label'?: string;
    content: string;
    tooltip?: ReactNode;
  }) => <button type="button" aria-label={ariaLabel ?? 'Copy'} />,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Download: () => <svg aria-hidden="true" />,
  EnvVarsInfoNote: ({
    children,
    runtimeConfigured,
  }: {
    children?: ReactNode;
    runtimeConfigured?: boolean;
  }) => (
    <div>
      {children ??
        (runtimeConfigured
          ? "These values are being passed via ENV vars and can't be overridden here."
          : "You can pass these in as ENV vars. When configured here, they're encrypted in the database.")}
    </div>
  ),
  ExternalLink: () => <svg aria-hidden="true" />,
  Info: () => <svg aria-hidden="true" />,
  Input: ({
    secret: _secret,
    ...props
  }: ButtonHTMLAttributes<HTMLInputElement> & { secret?: boolean }) => (
    <input {...props} />
  ),
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  Pencil: () => <svg aria-hidden="true" />,
  Plug: () => <svg aria-hidden="true" />,
  RefreshCw: () => <svg aria-hidden="true" />,
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Sparkles: () => <svg aria-hidden="true" />,
  Spinner: () => <span>loading</span>,
  Trash2: () => <svg aria-hidden="true" />,
  TriangleAlert: () => <svg aria-hidden="true" />,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/slack-app-manifest', () => ({
  buildSlackManifestPrefillUrl: () => 'https://slack.com/apps/new',
}));
vi.mock('@/lib/slack-callback-paths', () => ({
  SLACK_APP_INSTALL_CALLBACK_PATH: '/api/slack/callback',
  SLACK_SIGN_IN_CALLBACK_PATH: '/api/slack/signin',
}));
vi.mock('@/app/(onboarding)/setup/providerSetupCopy', () => ({
  getProviderSetupCopy: (providerId: 'slack' | 'microsoft' | 'telegram') =>
    ({
      slack: {
        creationHref: 'https://api.slack.com/apps?new_app=1',
        setupLabel: 'Slack app',
      },
      microsoft: {
        creationHref: 'https://portal.azure.com/apps',
        setupLabel: 'Microsoft Teams app',
      },
      telegram: {
        creationHref: 'https://t.me/BotFather',
        setupLabel: 'Telegram bot',
      },
    })[providerId],
}));
vi.mock('@/lib/settings', () => ({
  SETTINGS_PATHS: {
    comms: '/settings/comms',
    personal: '/settings/personal',
  },
}));

function buildSlackProvider(
  overrides: Partial<CommsProviderStatus> = {},
): CommsProviderStatus {
  return {
    id: 'slack',
    label: 'Slack',
    fields: [
      {
        envVarName: 'R_SLACK_CLIENT_ID',
        acceptedEnvVarNames: ['R_SLACK_CLIENT_ID'],
        label: 'Slack Client ID',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_SLACK_CLIENT_SECRET',
        acceptedEnvVarNames: ['R_SLACK_CLIENT_SECRET'],
        label: 'Slack Client Secret',
        secret: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_SLACK_SIGNING_SECRET',
        acceptedEnvVarNames: ['R_SLACK_SIGNING_SECRET'],
        label: 'Slack Signing Secret',
        secret: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
    ],
    runtimeSatisfied: false,
    savedSatisfied: false,
    setupSatisfied: false,
    ...overrides,
  };
}

function buildMicrosoftProvider(
  overrides: Partial<CommsProviderStatus> = {},
): CommsProviderStatus {
  return {
    id: 'microsoft',
    label: 'Microsoft Teams',
    fields: [
      {
        envVarName: 'R_MICROSOFT_CLIENT_ID',
        acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_ID'],
        label: 'Microsoft Client ID',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_MICROSOFT_CLIENT_SECRET',
        acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_SECRET'],
        label: 'Microsoft Client Secret',
        secret: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_MICROSOFT_TENANT_ID',
        acceptedEnvVarNames: ['R_MICROSOFT_TENANT_ID'],
        label: 'Microsoft Tenant ID',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TEAMS_BOT_APP_ID',
        acceptedEnvVarNames: ['R_TEAMS_BOT_APP_ID'],
        label: 'Teams Bot App ID',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TEAMS_BOT_APP_PASSWORD',
        acceptedEnvVarNames: ['R_TEAMS_BOT_APP_PASSWORD'],
        label: 'Teams Bot App Password',
        secret: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TEAMS_BOT_TENANT_ID',
        acceptedEnvVarNames: ['R_TEAMS_BOT_TENANT_ID'],
        label: 'Teams Bot Tenant ID',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TEAMS_BOT_TOKEN_ENDPOINT',
        acceptedEnvVarNames: ['R_TEAMS_BOT_TOKEN_ENDPOINT'],
        label: 'Teams Bot Token Endpoint',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TEAMS_BOT_OAUTH_SCOPE',
        acceptedEnvVarNames: ['R_TEAMS_BOT_OAUTH_SCOPE'],
        label: 'Teams Bot OAuth Scope',
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
    ],
    runtimeSatisfied: false,
    savedSatisfied: false,
    setupSatisfied: false,
    ...overrides,
  };
}

function buildTelegramProvider(
  overrides: Partial<CommsProviderStatus> = {},
): CommsProviderStatus {
  return {
    id: 'telegram',
    label: 'Telegram',
    fields: [
      {
        envVarName: 'R_TELEGRAM_BOT_TOKEN',
        acceptedEnvVarNames: ['R_TELEGRAM_BOT_TOKEN'],
        label: 'Telegram Bot Token',
        secret: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
      {
        envVarName: 'R_TELEGRAM_WEBHOOK_SECRET',
        acceptedEnvVarNames: ['R_TELEGRAM_WEBHOOK_SECRET'],
        label: 'Telegram Webhook Secret',
        secret: true,
        required: false,
        runtimeSatisfied: false,
        savedSatisfied: false,
        satisfiedByEnvVarName: null,
      },
    ],
    runtimeSatisfied: false,
    savedSatisfied: false,
    setupSatisfied: false,
    telegramWebhook: null,
    telegramBotUsername: null,
    ...overrides,
  };
}

describe('CommsProviderSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.slackInstallation = null;
    state.slackInstallationIsPending = false;
    state.connectSlackIsPending = false;
    state.disconnectSlackIsPending = false;
    state.connectSlackUrl = 'https://slack.com/install';
    state.teamsStatus = {
      botConfigured: false,
      botUsesTenantSpecificTokenFlow: false,
      microsoftAuthConfigured: false,
      webhookUrl: 'https://roomote.dev/api/webhooks/teams',
      openInTeamsUrl: null,
      primaryConversationReady: false,
      primaryConversationType: null,
    };
    state.teamsStatusIsPending = false;
    state.teamsStatusIsError = false;
    state.routerDebugSettings = {
      routerDebugSlackChannelId: null,
      envFallbackSlackChannelId: null,
      effectiveRouterDebugSlackChannelId: null,
      source: 'none',
    };
    state.routerDebugIsPending = false;
    state.routerDebugIsError = false;
    state.slackChannels = [];
    state.slackChannelsIsPending = false;
    state.slackChannelsIsError = false;
    state.slackChannelsIsFetching = false;
    state.updateRouterDebugIsPending = false;
  });

  describe('numbered setup instructions', () => {
    it('shows the Slack create-app screen first, then numbered manual setup in settings', () => {
      render(
        <CommsProviderSection
          provider={buildSlackProvider()}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

      expect(
        screen.queryByRole('heading', { name: 'Create Slack app' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Create Slack app' }),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: /Enter values manually/ }),
      );

      expect(
        screen.queryByRole('heading', { name: 'Configure Slack app' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText(/Create a new Slack app/)).toBeInTheDocument();
      expect(screen.getByText('Authorized redirect URLs')).toBeInTheDocument();
      expect(screen.getByText('Enter the values below:')).toBeInTheDocument();
    });

    it('shows numbered Microsoft setup with the settings env-var note', () => {
      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider()}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

      expect(
        screen.queryByRole('heading', {
          name: 'Configure Microsoft Teams app',
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('Create a Microsoft Entra app.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Enter the Microsoft Entra app generated values.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Upload Roomote to Microsoft Teams.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Add the Teams bot capability to that app.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "You can pass these in as ENV vars. When configured here, they're encrypted in the database.",
        ),
      ).toBeInTheDocument();
    });

    it('shows numbered Telegram setup without exposing the managed webhook secret', () => {
      render(
        <CommsProviderSection
          provider={buildTelegramProvider()}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

      expect(
        screen.queryByRole('heading', { name: 'Configure Telegram bot' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/Create a new Telegram bot/)).toBeInTheDocument();
      expect(screen.getByText('Create bot')).toBeInTheDocument();
      expect(screen.getByText('Bot token')).toBeInTheDocument();
      expect(screen.getByText('Threaded Mode')).toBeInTheDocument();
      expect(screen.queryByText('Webhook')).not.toBeInTheDocument();
      expect(screen.getByText('Enter the values below:')).toBeInTheDocument();
      expect(
        screen.getByText(/Roomote generates a webhook secret automatically/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Telegram Webhook Secret'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText('Telegram Webhook Secret'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Telegram Bot Token')).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText('Telegram Bot Token'),
      ).toBeInTheDocument();
    });

    it('lets users save Telegram with only a bot token when the secret is auto-managed', () => {
      const onSave = vi.fn();

      render(
        <CommsProviderSection
          provider={buildTelegramProvider()}
          onSave={onSave}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));
      fireEvent.change(screen.getByPlaceholderText('Telegram Bot Token'), {
        target: { value: 'bot-token' },
      });

      const saveButton = screen.getByRole('button', { name: 'Save' });
      expect(saveButton).not.toBeDisabled();
      fireEvent.click(saveButton);

      expect(onSave).toHaveBeenCalledWith('telegram', {
        R_TELEGRAM_BOT_TOKEN: 'bot-token',
      });
    });

    it('shows the concrete Telegram webhook check error instead of a generic reachability line', () => {
      render(
        <CommsProviderSection
          provider={buildTelegramProvider({
            telegramWebhook: {
              status: 'error',
              registeredUrl: null,
              expectedUrl: 'https://app.example.com/api/webhooks/telegram',
              lastErrorMessage:
                'Telegram rejected the bot token. Check the token from BotFather and save again.',
            },
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

      expect(
        screen.getByText(
          'Telegram rejected the bot token. Check the token from BotFather and save again.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          /Could not reach the Telegram Bot API to check the webhook/,
        ),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Last delivery error/)).not.toBeInTheDocument();
    });

    it('shows the connected Telegram bot username', () => {
      render(
        <CommsProviderSection
          provider={buildTelegramProvider({
            telegramBotUsername: 'RoomoteBot',
            telegramWebhook: {
              status: 'connected',
              registeredUrl: 'https://app.example.com/api/webhooks/telegram',
              expectedUrl: 'https://app.example.com/api/webhooks/telegram',
              lastErrorMessage: null,
            },
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

      expect(screen.getByText('Connected to @RoomoteBot')).toBeInTheDocument();
      expect(screen.queryByText('Webhook connected')).not.toBeInTheDocument();
    });
  });

  describe('Slack workspace auth button', () => {
    it('shows an Auth button when Slack is configured but not installed', () => {
      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByRole('button', { name: 'Auth Slack workspace' }),
      ).toBeInTheDocument();
    });

    it('shows a Re-auth button when Slack is installed', () => {
      state.slackInstallation = { teamName: 'Roomote' };
      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByRole('button', { name: 'Re-auth Slack workspace' }),
      ).toBeInTheDocument();
    });

    it('hides the auth button when Slack is not configured', () => {
      render(
        <CommsProviderSection
          provider={buildSlackProvider()}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.queryByRole('button', { name: 'Auth Slack workspace' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Re-auth Slack workspace' }),
      ).not.toBeInTheDocument();
    });

    it('starts Slack workspace authorization on Auth click', () => {
      const originalHref = window.location.href;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: new URL(originalHref),
      });

      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Auth Slack workspace' }),
      );

      expect(mutations.connectSlack).toHaveBeenCalled();
    });
  });

  describe('Slack diagnostics channel', () => {
    it('renders the diagnostics channel control when Slack is installed', () => {
      state.slackInstallation = { teamName: 'Roomote' };
      state.slackChannels = [
        {
          id: 'CDEBUG',
          name: 'router-debug',
          label: '#router-debug',
          isPrivate: false,
          isMember: true,
        },
      ];

      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(screen.getByText('Diagnostics channel')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Refresh Slack channels' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Refresh Slack channels' })
          .previousElementSibling,
      ).not.toBeNull();
    });

    it('hides the diagnostics channel control when Slack is not installed', () => {
      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(screen.queryByText('Diagnostics channel')).not.toBeInTheDocument();
    });
  });

  describe('Slack client id display', () => {
    it('shows the existing non-secret client id when present', () => {
      render(
        <CommsProviderSection
          provider={buildSlackProvider({
            savedSatisfied: true,
            setupSatisfied: true,
            fields: [
              {
                envVarName: 'R_SLACK_CLIENT_ID',
                acceptedEnvVarNames: ['R_SLACK_CLIENT_ID'],
                label: 'Slack Client ID',
                runtimeSatisfied: false,
                savedSatisfied: true,
                savedValue: 'A123.CLIENT',
                satisfiedByEnvVarName: 'R_SLACK_CLIENT_ID',
              },
              {
                envVarName: 'R_SLACK_CLIENT_SECRET',
                acceptedEnvVarNames: ['R_SLACK_CLIENT_SECRET'],
                label: 'Slack Client Secret',
                secret: true,
                runtimeSatisfied: false,
                savedSatisfied: true,
                savedValue: null,
                satisfiedByEnvVarName: 'R_SLACK_CLIENT_SECRET',
              },
              {
                envVarName: 'R_SLACK_SIGNING_SECRET',
                acceptedEnvVarNames: ['R_SLACK_SIGNING_SECRET'],
                label: 'Slack Signing Secret',
                secret: true,
                runtimeSatisfied: false,
                savedSatisfied: true,
                savedValue: null,
                satisfiedByEnvVarName: 'R_SLACK_SIGNING_SECRET',
              },
            ],
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(screen.getByDisplayValue('A123.CLIENT')).toBeInTheDocument();
    });
  });

  describe('Teams bot status', () => {
    it('renders bot status and Open in Teams link when configured', () => {
      state.teamsStatus = {
        botConfigured: true,
        botUsesTenantSpecificTokenFlow: true,
        microsoftAuthConfigured: true,
        webhookUrl: 'https://roomote.dev/api/webhooks/teams',
        openInTeamsUrl: 'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot',
        primaryConversationReady: true,
        primaryConversationType: 'channel',
      };

      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByText(/Team members can link Microsoft Teams accounts/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Teams Bot App ID')).toBeNull();
      expect(screen.queryByText('Teams Bot App ID (optional)')).toBeNull();
      expect(
        screen.getByRole('link', { name: /Open in Teams/ }),
      ).toBeInTheDocument();
    });

    it('renders the setup hint when the bot is not configured', () => {
      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByText(/R_TEAMS_BOT_APP_ID and R_TEAMS_BOT_APP_PASSWORD/),
      ).toBeInTheDocument();
    });

    it('shows bot status and app-package download when only R_TEAMS_BOT_* is configured (no Microsoft sign-in)', () => {
      state.teamsStatus = {
        botConfigured: true,
        botUsesTenantSpecificTokenFlow: true,
        microsoftAuthConfigured: false,
        webhookUrl: 'https://roomote.dev/api/webhooks/teams',
        openInTeamsUrl: 'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot',
        primaryConversationReady: true,
        primaryConversationType: 'personal',
      };

      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider({
            runtimeSatisfied: false,
            savedSatisfied: false,
            setupSatisfied: false,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByText(/Bot configured for incoming Teams messages/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /Open in Teams/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /Download Teams app package/ }),
      ).toBeInTheDocument();
    });

    it('nudges to send a first Teams message when the bot is configured but no conversation was captured', () => {
      state.teamsStatus = {
        botConfigured: true,
        botUsesTenantSpecificTokenFlow: true,
        microsoftAuthConfigured: true,
        webhookUrl: 'https://roomote.dev/api/webhooks/teams',
        openInTeamsUrl: 'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot',
        primaryConversationReady: false,
        primaryConversationType: null,
      };

      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.getByText(/has not captured a Teams conversation yet/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /Open in Teams/ }),
      ).toBeInTheDocument();
    });

    it('hides the capture nudge once a primary Teams conversation exists', () => {
      state.teamsStatus = {
        botConfigured: true,
        botUsesTenantSpecificTokenFlow: true,
        microsoftAuthConfigured: true,
        webhookUrl: 'https://roomote.dev/api/webhooks/teams',
        openInTeamsUrl: 'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot',
        primaryConversationReady: true,
        primaryConversationType: 'channel',
      };

      render(
        <CommsProviderSection
          provider={buildMicrosoftProvider({
            savedSatisfied: true,
            setupSatisfied: true,
          })}
          onSave={vi.fn()}
          onClear={vi.fn()}
          savePending={false}
          clearPending={false}
        />,
      );

      expect(
        screen.queryByText(/has not captured a Teams conversation yet/),
      ).not.toBeInTheDocument();
    });
  });
});
