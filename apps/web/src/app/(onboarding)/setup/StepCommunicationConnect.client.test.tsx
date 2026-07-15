import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SetupAuthProviderId, SetupAuthStatus } from '@roomote/types';

const {
  connectSlackMutateMock,
  slackInstallationState,
  slackInstallationOptionsMock,
  teamsStatusState,
  teamsStatusOptionsMock,
} = vi.hoisted(() => ({
  connectSlackMutateMock: vi.fn(),
  slackInstallationState: {
    data: null as unknown,
    isPending: false,
    isError: false,
  },
  slackInstallationOptionsMock: vi.fn(),
  teamsStatusState: {
    data: {
      botConfigured: true,
      botUsesTenantSpecificTokenFlow: false,
      microsoftAuthConfigured: true,
      webhookUrl: 'https://roomote.example.com/api/webhooks/teams',
      openInTeamsUrl:
        'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id' as
          | string
          | null,
      botName: 'Roomote',
      primaryConversationReady: true,
      primaryConversationType: 'channel' as string | null,
    },
    isPending: false,
    isError: false,
  },
  teamsStatusOptionsMock: vi.fn(),
}));

vi.mock('@/hooks/slack', () => ({
  useConnectSlack: () => ({
    mutate: connectSlackMutateMock,
    isPending: false,
  }),
  useSlackInstallation: (options: unknown) => {
    slackInstallationOptionsMock(options);
    return slackInstallationState;
  },
}));

vi.mock('@/hooks/teams', () => ({
  useTeamsIntegrationStatus: (options: unknown) => {
    teamsStatusOptionsMock(options);
    return teamsStatusState;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/components/system', () => ({
  BrandIcon: ({
    name,
    icon,
    ...props
  }: {
    name: string;
    icon: string;
  } & SVGProps<SVGSVGElement>) => <svg aria-label={name || icon} {...props} />,
  ExternalLink: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    asChild,
    children,
    ...props
  }: {
    asChild?: boolean;
    children: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => {
    if (asChild) {
      const child = children as ReactElement<
        AnchorHTMLAttributes<HTMLAnchorElement>
      >;

      return <a {...child.props}>{child.props.children}</a>;
    }

    return (
      <button type={props.type ?? 'button'} {...props}>
        {children}
      </button>
    );
  },
}));

vi.mock('@/components/sandbox', () => ({
  TaskStatusIndicator: ({
    phase,
    compact,
  }: {
    phase?: string | null;
    compact?: boolean;
  }) => (
    <span data-compact={String(Boolean(compact))} data-testid="task-status">
      {phase}
    </span>
  ),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepCommunicationConnect } from './StepCommunicationConnect';

function buildAuthSetup(provider: SetupAuthProviderId): SetupAuthStatus {
  return {
    selectedProvider: provider,
    preselectedProvider: provider,
    runtimeConfiguredProvider: provider,
    runtimeConfiguredProviders: [provider],
    lockReason: 'runtime_env',
    setupSatisfiedByRuntimeEnv: true,
    managedConnection: null,
    providers: [
      {
        id: provider,
        label: provider === 'microsoft' ? 'Microsoft Teams' : 'Slack',
        fields: [],
        runtimeSatisfied: true,
        savedSatisfied: false,
        setupSatisfied: true,
      },
    ],
  };
}

function buildManagedAuthSetup(
  provider: 'slack' | 'microsoft',
): SetupAuthStatus {
  return {
    ...buildAuthSetup(provider),
    managedConnection: {
      cloudUrl: 'https://cloud.example/account',
      deploymentId: 'deployment-1',
      providers: [provider],
    },
  };
}

describe('StepCommunicationConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    teamsStatusState.data = {
      botConfigured: true,
      botUsesTenantSpecificTokenFlow: false,
      microsoftAuthConfigured: true,
      webhookUrl: 'https://roomote.example.com/api/webhooks/teams',
      openInTeamsUrl:
        'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id',
      botName: 'Roomote',
      primaryConversationReady: true,
      primaryConversationType: 'channel',
    };
    teamsStatusState.isPending = false;
    teamsStatusState.isError = false;
    slackInstallationState.data = null;
    slackInstallationState.isPending = false;
    slackInstallationState.isError = false;
  });

  it('renders the Slack OAuth CTA for Slack', () => {
    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('slack')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Connect to Slack/i }));

    expect(
      screen.getByText(/This deployment is already configured for Slack/i),
    ).toBeInTheDocument();
    expect(connectSlackMutateMock).toHaveBeenCalledTimes(1);
  });

  it('shows a subtle skip link for Slack and calls onSkip', () => {
    const onSkip = vi.fn();

    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('slack')}
        onContinue={vi.fn()}
        onSkip={onSkip}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(connectSlackMutateMock).not.toHaveBeenCalled();
  });

  it('renders the Teams bot CTA when Teams is ready', () => {
    const onContinue = vi.fn();

    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={onContinue}
        onSkip={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', {
      name: /Open Microsoft Teams bot/i,
    });

    expect(link).toHaveAttribute(
      'href',
      'https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows a yellow waiting status before a Teams conversation is captured', () => {
    teamsStatusState.data = {
      ...teamsStatusState.data,
      botName: 'Acme Assistant',
      primaryConversationReady: false,
      primaryConversationType: null,
    };

    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText('Waiting for bot message')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Send a message to the Acme Assistant bot on Teams to complete the connection',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('task-status')).toHaveTextContent('stopped');
    expect(
      screen.getByRole('link', { name: /Open Microsoft Teams bot/i }),
    ).toBeInTheDocument();
  });

  it('shows a green waiting status when the Teams conversation is captured', () => {
    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText('Received!')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Send a message to the Roomote bot on Teams to complete the connection',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('task-status')).toHaveTextContent(
      'waiting_for_prompt',
    );
  });

  it('renders a skip control when Teams has no bot URL', () => {
    const onSkip = vi.fn();
    teamsStatusState.data = {
      botConfigured: false,
      botUsesTenantSpecificTokenFlow: false,
      microsoftAuthConfigured: true,
      webhookUrl: 'https://roomote.example.com/api/webhooks/teams',
      openInTeamsUrl: null,
      botName: 'Roomote',
      primaryConversationReady: false,
      primaryConversationType: null,
    };

    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={onSkip}
      />,
    );

    expect(screen.getByText(/bot app ID is missing/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Open Microsoft Teams bot/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('renders a skip control when Teams status cannot be loaded', () => {
    const onSkip = vi.fn();
    teamsStatusState.isError = true;

    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={onSkip}
      />,
    );

    expect(
      screen.getByText(/Unable to load Microsoft Teams setup status/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Do this later' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('opens Cloud for a managed Slack connection and polls until it is ready', () => {
    render(
      <StepCommunicationConnect
        authSetup={buildManagedAuthSetup('slack')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Roomote Cloud provides the app for this deployment/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open Roomote Cloud/i }),
    ).toHaveAttribute(
      'href',
      'https://cloud.example/account?connect=slack&deployment=deployment-1',
    );
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();
    expect(slackInstallationOptionsMock).toHaveBeenCalledWith({
      enabled: true,
      refetchInterval: 2_000,
    });
    expect(connectSlackMutateMock).not.toHaveBeenCalled();
  });

  it('continues after a managed Slack installation reaches the tenant', () => {
    const onContinue = vi.fn();
    slackInstallationState.data = { teamId: 'team-1' };

    render(
      <StepCommunicationConnect
        authSetup={buildManagedAuthSetup('slack')}
        onContinue={onContinue}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText('Slack connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('uses the managed Teams Cloud flow and polls tenant readiness', () => {
    render(
      <StepCommunicationConnect
        authSetup={buildManagedAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText('Microsoft Teams connected')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open Roomote Cloud/i }),
    ).toHaveAttribute(
      'href',
      'https://cloud.example/account?connect=teams&deployment=deployment-1',
    );
    expect(teamsStatusOptionsMock).toHaveBeenCalledWith({
      enabled: true,
      refetchInterval: 2_000,
    });
  });
});
