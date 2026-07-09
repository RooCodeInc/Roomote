import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SetupAuthProviderId, SetupAuthStatus } from '@roomote/types';

const { connectSlackMutateMock, teamsStatusState } = vi.hoisted(() => ({
  connectSlackMutateMock: vi.fn(),
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
      primaryConversationReady: true,
      primaryConversationType: 'channel' as string | null,
    },
    isPending: false,
    isError: false,
  },
}));

vi.mock('@/hooks/slack', () => ({
  useConnectSlack: () => ({
    mutate: connectSlackMutateMock,
    isPending: false,
  }),
}));

vi.mock('@/hooks/teams', () => ({
  useTeamsIntegrationStatus: () => teamsStatusState,
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
      primaryConversationReady: true,
      primaryConversationType: 'channel',
    };
    teamsStatusState.isPending = false;
    teamsStatusState.isError = false;
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
    expect(
      screen.getByRole('link', { name: /Download the app package/i }),
    ).toHaveAttribute('href', '/api/teams/app-package');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('nudges to send a first message when no Teams conversation was captured yet', () => {
    teamsStatusState.data = {
      ...teamsStatusState.data,
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

    expect(
      screen.getByText(/has not received a Teams message yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open Microsoft Teams bot/i }),
    ).toBeInTheDocument();
  });

  it('hides the first-message nudge when the Teams conversation is captured', () => {
    render(
      <StepCommunicationConnect
        authSetup={buildAuthSetup('microsoft')}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/has not received a Teams message yet/i),
    ).not.toBeInTheDocument();
  });

  it('renders a blocked state when Teams has no bot URL', () => {
    teamsStatusState.data = {
      botConfigured: false,
      botUsesTenantSpecificTokenFlow: false,
      microsoftAuthConfigured: true,
      webhookUrl: 'https://roomote.example.com/api/webhooks/teams',
      openInTeamsUrl: null,
      primaryConversationReady: false,
      primaryConversationType: null,
    };
    const onSkip = vi.fn();

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
});
