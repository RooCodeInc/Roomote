import { fireEvent, render, screen } from '@testing-library/react';

import type { OnboardingLinkableProvider } from '@/app/(onboarding)/onboarding/types';

let isAdmin = true;
let linkableProviders: OnboardingLinkableProvider[] = [];
let enabledMcpIds: string[] = [];
let linkedMcpIds: string[] = [];
let orgHasLinear = false;
let userHasLinkedLinear = false;

const {
  mockPush,
  mockReplace,
  mockAuthenticateSlack,
  mockAuthenticateGitHub,
  mockAuthenticateLinear,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockAuthenticateSlack: vi.fn(),
  mockAuthenticateGitHub: vi.fn(),
  mockAuthenticateLinear: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin }),
}));

vi.mock('@/hooks/mcp-connections', () => ({
  useDeploymentMcpEnablements: () => ({
    data: enabledMcpIds.map((mcpId) => ({ mcpId, enabled: true })),
    isPending: false,
  }),
  useUserMcpConnections: () => ({
    data: linkedMcpIds.map((mcpId) => ({ mcpId, authStatus: 'authenticated' })),
    isPending: false,
  }),
  useConnectMcp: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock('@/hooks/github', () => ({
  useAuthenticateGitHubAccount: () => ({
    isPending: false,
    mutate: mockAuthenticateGitHub,
  }),
}));

vi.mock('@/hooks/slack', () => ({
  useAuthenticateSlackAccount: () => ({
    isPending: false,
    mutate: mockAuthenticateSlack,
  }),
}));

vi.mock('@/hooks/linear', () => ({
  useAuthenticateLinearAccount: () => ({
    isPending: false,
    mutate: mockAuthenticateLinear,
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAuthenticateAdoAccount: () => ({ isPending: false, mutate: vi.fn() }),
  useAuthenticateBitbucketAccount: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useAuthenticateGiteaAccount: () => ({ isPending: false, mutate: vi.fn() }),
  useAuthenticateGitLabAccount: () => ({ isPending: false, mutate: vi.fn() }),
  useAuthenticateMicrosoftTeamsAccount: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    onboarding: {
      status: { queryOptions: () => ({ queryKey: ['onboarding'] }) },
    },
    automations: {
      onboardingStatus: { queryOptions: () => ({ queryKey: ['automations'] }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: string[] }) =>
    options.queryKey[0] === 'onboarding'
      ? {
          data: {
            linkableProviders,
            orgHasLinear,
            userHasLinkedLinear,
          },
          isPending: false,
        }
      : { data: { hasEnabledAutomations: true }, isPending: false },
}));

vi.mock('motion/react', async () => {
  const { forwardRef } = await import('react');

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      div: forwardRef<
        HTMLDivElement,
        React.ComponentPropsWithoutRef<'div'> & {
          initial?: unknown;
          animate?: unknown;
          exit?: unknown;
          variants?: unknown;
          transition?: unknown;
        }
      >(
        (
          {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            variants: _variants,
            transition: _transition,
            ...props
          },
          ref,
        ) => <div ref={ref} {...props} />,
      ),
    },
  };
});

vi.mock('@/components/settings/McpIcon', () => ({
  McpIcon: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock('@/components/settings/DiscordLinkAccountStep', () => ({
  DiscordLinkAccountStep: () => <div>Discord link flow</div>,
}));

vi.mock('@/components/settings/TelegramLinkAccountStep', () => ({
  TelegramLinkAccountStep: () => <div>Telegram link flow</div>,
}));

import { OnboardingCard } from './OnboardingCard';

function dismissCard() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
}

beforeEach(() => {
  isAdmin = true;
  linkableProviders = [];
  enabledMcpIds = [];
  linkedMcpIds = [];
  orgHasLinear = false;
  userHasLinkedLinear = false;
  localStorage.clear();
  vi.clearAllMocks();
});

it('prioritizes communication accounts before source-control accounts', () => {
  linkableProviders = [
    {
      id: 'github',
      category: 'source-control',
      label: 'GitHub',
      configured: true,
      linked: false,
    },
    {
      id: 'discord',
      category: 'communication',
      label: 'Discord',
      configured: true,
      linked: false,
    },
    {
      id: 'slack',
      category: 'communication',
      label: 'Slack',
      configured: true,
      linked: false,
    },
  ];

  render(<OnboardingCard />);
  expect(screen.getByText('Link your Slack account')).toBeInTheDocument();
  dismissCard();
  expect(screen.getByText('Link your Discord account')).toBeInTheDocument();
  dismissCard();
  expect(screen.getByText('Link your GitHub account')).toBeInTheDocument();
});

it('does not offer Slack installation, but links an installed Slack account', () => {
  linkableProviders = [
    {
      id: 'slack',
      category: 'communication',
      label: 'Slack',
      configured: false,
      linked: false,
    },
  ];

  render(<OnboardingCard />);
  expect(
    screen.queryByText(/Chat with Roomote on Slack/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText('Enable Notion for your workspace'),
  ).toBeInTheDocument();
});

it('uses the requested admin integration setup order', () => {
  render(<OnboardingCard />);

  for (const name of [
    'Notion',
    'Sentry',
    'Linear',
    'Jira',
    'Vercel',
    'Supabase',
    'PostHog',
    'Grafana',
    'Asana',
  ]) {
    expect(
      screen.getByText(`Enable ${name} for your workspace`),
    ).toBeInTheDocument();
    dismissCard();
  }
});

it('opens the highlighted integration settings for admin setup', () => {
  render(<OnboardingCard />);

  fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));
  expect(mockPush).toHaveBeenCalledWith(
    '/settings/integrations?highlight=notion',
  );
});

it('does not show workspace setup to non-admins and prompts enabled personal MCP links', () => {
  isAdmin = false;
  enabledMcpIds = ['notion'];

  render(<OnboardingCard />);
  expect(screen.getByText('Link your Notion account')).toBeInTheDocument();
  expect(
    screen.queryByText('Enable Notion for your workspace'),
  ).not.toBeInTheDocument();
});

it('starts Slack linking directly', () => {
  linkableProviders = [
    {
      id: 'slack',
      category: 'communication',
      label: 'Slack',
      configured: true,
      linked: false,
    },
  ];
  render(<OnboardingCard />);

  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  expect(mockAuthenticateSlack).toHaveBeenCalledWith('/', expect.any(Object));
});

it('opens the Discord account-link dialog directly', () => {
  linkableProviders = [
    {
      id: 'discord',
      category: 'communication',
      label: 'Discord',
      configured: true,
      linked: false,
    },
  ];
  render(<OnboardingCard />);

  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  expect(screen.getByText('Discord link flow')).toBeInTheDocument();
});
