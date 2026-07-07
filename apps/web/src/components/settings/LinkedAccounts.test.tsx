import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FeatureFlag } from '@roomote/feature-flags';
import {
  isDeploymentScopedMcpIntegration,
  MCP_INTEGRATIONS,
} from '@roomote/types';
import { toast } from 'sonner';

const defaultUserScopedEnabledMcpIntegrations = MCP_INTEGRATIONS.filter(
  (integration) =>
    !isDeploymentScopedMcpIntegration(integration) &&
    integration.id === 'notion',
);
const defaultEnabledMcpIds = new Set(
  defaultUserScopedEnabledMcpIntegrations.map((integration) => integration.id),
);
const linkedIntegration = MCP_INTEGRATIONS.find(
  (integration) =>
    !defaultEnabledMcpIds.has(integration.id) &&
    !isDeploymentScopedMcpIntegration(integration),
);

if (!linkedIntegration) {
  throw new Error('Expected at least one non-default MCP integration.');
}

if (defaultEnabledMcpIds.has(linkedIntegration.id)) {
  throw new Error(
    'Expected the linked integration to be outside the default-enabled set.',
  );
}

function createMcpEnablements(enabledMcpIds: Set<string>) {
  return MCP_INTEGRATIONS.map((integration) => ({
    mcpId: integration.id,
    enabled: enabledMcpIds.has(integration.id),
  }));
}

const state = vi.hoisted(() => ({
  searchParams: '',
  user: {
    isAdmin: true,
    featureFlags: {} as Partial<Record<FeatureFlag, boolean>>,
  },
  deploymentEnablements: [] as Array<{ mcpId: string; enabled: boolean }>,
  deploymentEnablementsIsPending: false,
  userConnections: [] as Array<{ mcpId: string; authStatus: string }>,
  userConnectionsIsPending: false,
  gitHubInstallations: [{ id: 'gh-1' }],
  gitHubInstallationsIsPending: false,
  githubAccount: null,
  gitlabAccount: {
    configured: false,
    account: null,
  } as {
    configured: boolean;
    account: {
      accountId: string;
      displayName: string | null;
    } | null;
  },
  gitlabAccountIsPending: false,
  giteaAccount: {
    configured: false,
    account: null,
  } as {
    configured: boolean;
    account: {
      accountId: string;
      displayName: string | null;
    } | null;
  },
  giteaAccountIsPending: false,
  adoAccount: {
    configured: false,
    account: null,
  } as {
    configured: boolean;
    account: {
      accountId: string;
      displayName: string | null;
    } | null;
  },
  adoAccountIsPending: false,
  telegramAccount: null as {
    configured: boolean;
    mapping: { telegramUserId: string; telegramUsername: string | null } | null;
  } | null,
  slackInstallation: null as { teamName: string } | null,
  slackInstallationIsPending: false,
  slackAccount: null as {
    slackUserId: string;
    slackTeamId?: string;
    teamName: string | null;
  } | null,
  linearInstallation: {
    linearOrganizationName: 'Roomote',
    linearOrganizationUrlKey: 'roomote',
  } as {
    linearOrganizationName: string;
    linearOrganizationUrlKey: string;
  } | null,
  linearInstallationIsPending: false,
  linearAccount: {
    linearUserId: 'linear-user-1',
    linearOrganizationName: 'Roomote',
  } as {
    linearUserId: string;
    linearOrganizationName: string;
  } | null,
  microsoftTeamsAccount: {
    configured: false,
    account: null,
  } as {
    configured: boolean;
    account: {
      accountId: string;
      displayName: string | null;
      tenantId: string | null;
    } | null;
  },
  microsoftTeamsAccountIsPending: false,
}));

const mutations = vi.hoisted(() => ({
  authenticateGitHub: vi.fn(),
  authenticateGitLab: vi.fn(),
  authenticateGitea: vi.fn(),
  authenticateAdo: vi.fn(),
  authenticateSlack: vi.fn(),
  authenticateLinear: vi.fn(),
  authenticateMicrosoftTeams: vi.fn(),
  unlinkGitLab: vi.fn(),
  unlinkGitea: vi.fn(),
  unlinkAdo: vi.fn(),
  unlinkGitHub: vi.fn(),
  unlinkSlack: vi.fn(),
  unlinkLinear: vi.fn(),
  unlinkMicrosoftTeams: vi.fn(),
  connectMcp: vi.fn(),
  disconnectMcp: vi.fn(),
}));

type AuthClientLinkedAccountTestCase = {
  name: string;
  searchParams: string;
  linkedAccount: {
    accountId: string;
    displayName: string;
    tenantId?: string | null;
  };
  setLinkedAccount: (
    account: {
      accountId: string;
      displayName: string | null;
      tenantId?: string | null;
    } | null,
  ) => void;
  authenticateMutation: ReturnType<typeof vi.fn>;
  unlinkMutation: ReturnType<typeof vi.fn>;
  expectedLinkArgs: string;
};

const authClientLinkedAccountTestCases = [
  {
    name: 'Azure DevOps',
    searchParams: 'service=ado',
    linkedAccount: {
      accountId: 'ado-user-1',
      displayName: 'Azure DevOps user ado-user-1',
    },
    setLinkedAccount: (
      account: {
        accountId: string;
        displayName: string | null;
        tenantId?: string | null;
      } | null,
    ) => {
      state.adoAccount = {
        configured: true,
        account: account
          ? {
              accountId: account.accountId,
              displayName: account.displayName,
            }
          : null,
      };
    },
    authenticateMutation: mutations.authenticateAdo,
    unlinkMutation: mutations.unlinkAdo,
    expectedLinkArgs: '/settings?service=ado',
  },
  {
    name: 'GitLab',
    searchParams: 'service=gitlab',
    linkedAccount: {
      accountId: 'alice',
      displayName: '@alice',
    },
    setLinkedAccount: (
      account: {
        accountId: string;
        displayName: string | null;
        tenantId?: string | null;
      } | null,
    ) => {
      state.gitlabAccount = {
        configured: true,
        account: account
          ? {
              accountId: account.accountId,
              displayName: account.displayName,
            }
          : null,
      };
    },
    authenticateMutation: mutations.authenticateGitLab,
    unlinkMutation: mutations.unlinkGitLab,
    expectedLinkArgs: '/settings?service=gitlab',
  },
  {
    name: 'Gitea',
    searchParams: 'service=gitea',
    linkedAccount: {
      accountId: '42',
      displayName: 'Gitea user 42',
    },
    setLinkedAccount: (
      account: {
        accountId: string;
        displayName: string | null;
        tenantId?: string | null;
      } | null,
    ) => {
      state.giteaAccount = {
        configured: true,
        account: account
          ? {
              accountId: account.accountId,
              displayName: account.displayName,
            }
          : null,
      };
    },
    authenticateMutation: mutations.authenticateGitea,
    unlinkMutation: mutations.unlinkGitea,
    expectedLinkArgs: '/settings?service=gitea',
  },
  {
    name: 'Microsoft Teams',
    searchParams: 'service=teams',
    linkedAccount: {
      accountId: 'microsoft-1',
      displayName: 'ada@example.com',
      tenantId: 'tenant-1',
    },
    setLinkedAccount: (
      account: {
        accountId: string;
        displayName: string | null;
        tenantId?: string | null;
      } | null,
    ) => {
      state.microsoftTeamsAccount = {
        configured: true,
        account: account
          ? {
              ...account,
              tenantId: account.tenantId ?? null,
            }
          : null,
      };
    },
    authenticateMutation: mutations.authenticateMicrosoftTeams,
    unlinkMutation: mutations.unlinkMicrosoftTeams,
    expectedLinkArgs: '/settings?service=teams',
  },
] satisfies AuthClientLinkedAccountTestCase[];

function getLinkedAccountRow(name: string) {
  const row = screen.getByText(name).closest('div.py-1');

  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected the ${name} row container to render.`);
  }

  return row;
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(state.searchParams),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => state.user,
}));

vi.mock('@/hooks/github', () => ({
  useGitHubInstallations: () => ({
    data: state.gitHubInstallations,
    isPending: state.gitHubInstallationsIsPending,
  }),
  useAuthenticateGitHubAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateGitHub,
  }),
}));

vi.mock('@/hooks/slack', () => ({
  useSlackInstallation: () => ({
    data: state.slackInstallation,
    isPending: state.slackInstallationIsPending,
  }),
  useAuthenticateSlackAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateSlack,
  }),
}));

vi.mock('@/hooks/linear', () => ({
  useLinearInstallation: () => ({
    data: state.linearInstallation,
    isPending: state.linearInstallationIsPending,
  }),
  useAuthenticateLinearAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateLinear,
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAuthenticateAdoAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateAdo,
  }),
  useAdoLinkedAccount: () => ({
    data: state.adoAccount,
    isPending: state.adoAccountIsPending,
  }),
  useAuthenticateGitLabAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateGitLab,
  }),
  useGitLabLinkedAccount: () => ({
    data: state.gitlabAccount,
    isPending: state.gitlabAccountIsPending,
  }),
  useAuthenticateGiteaAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateGitea,
  }),
  useGiteaLinkedAccount: () => ({
    data: state.giteaAccount,
    isPending: state.giteaAccountIsPending,
  }),
  useGitHubLinkedAccount: () => ({
    data: state.githubAccount,
    isPending: false,
  }),
  useTelegramLinkedAccount: () => ({
    data: state.telegramAccount,
    isPending: false,
    refetch: vi.fn(),
  }),
  useCreateTelegramLinkCode: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUnlinkTelegramLinkedAccount: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useLinearLinkedAccount: () => ({
    data: state.linearAccount,
    isPending: false,
  }),
  useSlackLinkedAccount: () => ({
    data: state.slackAccount,
    isPending: false,
  }),
  useMicrosoftTeamsLinkedAccount: () => ({
    data: state.microsoftTeamsAccount,
    isPending: state.microsoftTeamsAccountIsPending,
  }),
  useAuthenticateMicrosoftTeamsAccount: () => ({
    isPending: false,
    mutate: mutations.authenticateMicrosoftTeams,
  }),
  useUnlinkGitHubLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkGitHub,
  }),
  useUnlinkAdoLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkAdo,
  }),
  useUnlinkGitLabLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkGitLab,
  }),
  useUnlinkGiteaLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkGitea,
  }),
  useUnlinkLinearLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkLinear,
  }),
  useUnlinkSlackLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkSlack,
  }),
  useUnlinkMicrosoftTeamsLinkedAccount: () => ({
    isPending: false,
    mutate: mutations.unlinkMicrosoftTeams,
  }),
}));

vi.mock('@/hooks/mcp-connections', () => ({
  useDeploymentMcpEnablements: () => ({
    data: state.deploymentEnablements,
    isPending: state.deploymentEnablementsIsPending,
  }),
  useUserMcpConnections: () => ({
    data: state.userConnections,
    isPending: state.userConnectionsIsPending,
  }),
  useConnectMcp: () => ({
    isPending: false,
    mutate: mutations.connectMcp,
    variables: undefined,
  }),
  useDisconnectMcp: () => ({
    isPending: false,
    mutate: mutations.disconnectMcp,
    variables: undefined,
  }),
}));

vi.mock('@/components/system', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  BrandIcon: ({ name, className }: { name: string; className?: string }) => (
    <svg role="img" aria-label={name} className={className} />
  ),
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Github: () => <svg aria-hidden="true" />,
  LinearLogo: () => <svg aria-hidden="true" />,
  LucideLink: () => <svg aria-hidden="true" />,
  Skeleton: ({ className }: { className?: string }) => (
    <div data-slot="skeleton" className={className}>
      loading
    </div>
  ),
  Slack: () => <svg aria-hidden="true" />,
  Spinner: () => <span>loading</span>,
  X: () => <svg aria-hidden="true" />,
}));

vi.mock('./Section', () => ({
  Section: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { LinkedAccounts } from './LinkedAccounts';

describe('LinkedAccounts settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutations.authenticateAdo.mockReset();
    mutations.authenticateGitLab.mockReset();
    mutations.authenticateGitea.mockReset();
    mutations.unlinkAdo.mockReset();
    mutations.unlinkGitLab.mockReset();
    mutations.unlinkGitea.mockReset();
    state.searchParams = '';
    state.user = {
      isAdmin: true,
      featureFlags: {} as Partial<Record<FeatureFlag, boolean>>,
    };
    state.deploymentEnablements = [
      { mcpId: 'betterstack', enabled: true },
      ...createMcpEnablements(defaultEnabledMcpIds),
    ];
    state.deploymentEnablementsIsPending = false;
    state.userConnections = [];
    state.userConnectionsIsPending = false;
    state.gitHubInstallations = [{ id: 'gh-1' }];
    state.gitHubInstallationsIsPending = false;
    state.githubAccount = null;
    state.gitlabAccount = { configured: false, account: null };
    state.gitlabAccountIsPending = false;
    state.giteaAccount = { configured: false, account: null };
    state.giteaAccountIsPending = false;
    state.adoAccount = { configured: false, account: null };
    state.adoAccountIsPending = false;
    state.telegramAccount = null;
    state.slackInstallation = null;
    state.slackInstallationIsPending = false;
    state.slackAccount = null;
    state.linearInstallation = {
      linearOrganizationName: 'Roomote',
      linearOrganizationUrlKey: 'roomote',
    };
    state.linearInstallationIsPending = false;
    state.linearAccount = {
      linearUserId: 'linear-user-1',
      linearOrganizationName: 'Roomote',
    };
    state.microsoftTeamsAccount = {
      configured: false,
      account: null,
    };
    state.microsoftTeamsAccountIsPending = false;
  });

  it('shows only rows for enabled user-linked apps and excludes org-scoped MCP integrations', () => {
    render(<LinkedAccounts />);

    const linearRow = screen.getByText('Linear').closest('div.py-1');
    if (!(linearRow instanceof HTMLElement)) {
      throw new Error('Expected the Linear row container to render.');
    }

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Linear')).toBeInTheDocument();
    expect(screen.queryByText('Linked')).not.toBeInTheDocument();
    expect(screen.queryByText('Not linked')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Link your GitHub account so Roomote can use your user identity when needed.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
    expect(screen.queryByText('Better Stack')).not.toBeInTheDocument();
    expect(screen.queryByText('Sentry')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Link GitHub account' }),
    ).toBeInTheDocument();
    expect(within(linearRow).getByText('Roomote')).toBeInTheDocument();
    expect(screen.queryByText('linear-user-1')).not.toBeInTheDocument();

    for (const integration of defaultUserScopedEnabledMcpIntegrations) {
      expect(screen.getByText(integration.name)).toBeInTheDocument();
      expect(
        screen.getByRole('button', {
          name: `Link ${integration.name} account`,
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole('img', { name: integration.name })).toHaveClass(
        'text-foreground/80',
      );
    }

    for (const integration of MCP_INTEGRATIONS) {
      if (
        defaultEnabledMcpIds.has(integration.id) ||
        integration.id === 'linear'
      ) {
        continue;
      }

      expect(screen.queryByText(integration.name)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', {
          name: `Link ${integration.name} account`,
        }),
      ).not.toBeInTheDocument();
    }
  });

  it('renders an enabled MCP linked account with unlink actions when authenticated', () => {
    state.deploymentEnablements = [
      ...createMcpEnablements(new Set([linkedIntegration.id])),
    ];
    state.userConnections = [
      { mcpId: linkedIntegration.id, authStatus: 'authenticated' },
    ];

    render(<LinkedAccounts />);

    expect(
      screen.getByRole('img', { name: linkedIntegration.name }),
    ).toHaveClass('text-foreground/80');
    expect(
      screen.getByRole('button', {
        name: `Unlink ${linkedIntegration.name} account`,
      }),
    ).toBeInTheDocument();
  });

  it('shows member guidance when no linked-account integrations are enabled', () => {
    state.user.isAdmin = false;
    state.deploymentEnablements = [];
    state.userConnections = [];
    state.gitHubInstallations = [];
    state.slackInstallation = null;
    state.linearInstallation = null;
    state.linearAccount = null;

    render(<LinkedAccounts />);

    expect(
      screen.getByText(
        'No personal linked accounts are available for this deployment yet. Ask an admin to enable a user-linked app in deployment integrations, then come back here to link your account.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'No personal linked accounts are available yet. Enable a user-linked app in deployment integrations, then come back here to link your account.',
      ),
    ).not.toBeInTheDocument();
  });

  it('keeps GitHub first, Slack second, and sorts the remaining accounts alphabetically', () => {
    state.deploymentEnablements = createMcpEnablements(
      new Set(['braintrust', 'notion']),
    );
    state.slackInstallation = { teamName: 'Roomote' };
    state.slackAccount = {
      teamName: 'Roomote',
      slackUserId: 'U08ELT3D32A',
    };
    state.microsoftTeamsAccount = {
      configured: true,
      account: {
        accountId: 'microsoft-1',
        displayName: 'ada@example.com',
        tenantId: 'tenant-1',
      },
    };
    state.adoAccount = {
      configured: true,
      account: {
        accountId: 'ado-user-1',
        displayName: 'Azure DevOps user ado-user-1',
      },
    };
    render(<LinkedAccounts />);

    expect(
      screen
        .getAllByText(
          /^(GitHub|Slack|Azure DevOps|Braintrust|Linear|Microsoft Teams|Notion)$/,
        )
        .map((element) => element.textContent),
    ).toEqual([
      'GitHub',
      'Slack',
      'Azure DevOps',
      'Braintrust',
      'Linear',
      'Microsoft Teams',
      'Notion',
    ]);
  });

  it('shows a 2-row skeleton while linked accounts are still loading instead of the empty state', () => {
    state.deploymentEnablements = [];
    state.deploymentEnablementsIsPending = true;
    state.userConnections = [];
    state.userConnectionsIsPending = true;
    state.gitHubInstallations = [];
    state.gitHubInstallationsIsPending = true;
    state.slackInstallation = null;
    state.slackInstallationIsPending = true;
    state.linearInstallation = null;
    state.linearInstallationIsPending = true;
    state.linearAccount = null;

    render(<LinkedAccounts />);

    expect(
      screen.queryByText(
        'No personal linked accounts are available yet. Enable a user-linked app in workspace integrations, then come back here to link your account.',
      ),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(6);
  });

  it('does not render org-scoped MCPs in linked accounts', () => {
    state.user.isAdmin = false;
    state.deploymentEnablements = createMcpEnablements(
      new Set(['betterstack', 'posthog', 'pylon', 'railway']),
    );
    state.userConnections = [];
    state.gitHubInstallations = [];
    state.linearInstallation = null;
    state.linearAccount = null;

    render(<LinkedAccounts />);

    expect(screen.queryByText('Better Stack')).not.toBeInTheDocument();
    expect(screen.queryByText('PostHog')).not.toBeInTheDocument();
    expect(screen.queryByText('Pylon')).not.toBeInTheDocument();
    expect(screen.queryByText('Railway')).not.toBeInTheDocument();
    expect(screen.queryByText('Sentry')).not.toBeInTheDocument();
  });

  it('starts the Linear OAuth account-link flow when linking', () => {
    state.linearAccount = null;

    render(<LinkedAccounts />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Link Linear account' }),
    );

    expect(mutations.authenticateLinear).toHaveBeenCalledWith(
      '/settings',
      expect.objectContaining({
        onError: expect.any(Function),
      }),
    );
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('starts the Slack OAuth account-link flow when linking', () => {
    state.slackInstallation = { teamName: 'Roomote' };
    state.slackAccount = null;

    render(<LinkedAccounts />);

    fireEvent.click(screen.getByRole('button', { name: 'Link Slack account' }));

    expect(mutations.authenticateSlack).toHaveBeenCalledWith(
      '/settings',
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it.each(authClientLinkedAccountTestCases)(
    'renders a linked $name account with unlink actions',
    ({ linkedAccount, name, setLinkedAccount }) => {
      setLinkedAccount(linkedAccount);

      render(<LinkedAccounts />);

      const row = getLinkedAccountRow(name);

      expect(
        within(row).getByText(linkedAccount.displayName),
      ).toBeInTheDocument();
      expect(
        within(row).getByRole('button', {
          name: `Unlink ${name} account`,
        }),
      ).toBeInTheDocument();
    },
  );

  it.each(authClientLinkedAccountTestCases)(
    'starts the $name OAuth account-link flow when linking',
    ({
      authenticateMutation,
      expectedLinkArgs,
      name,
      searchParams,
      setLinkedAccount,
    }) => {
      state.searchParams = searchParams;
      setLinkedAccount(null);

      render(<LinkedAccounts />);

      fireEvent.click(
        screen.getByRole('button', { name: `Link ${name} account` }),
      );

      expect(authenticateMutation).toHaveBeenCalledWith(
        expectedLinkArgs,
        expect.objectContaining({
          onError: expect.any(Function),
        }),
      );
    },
  );

  it.each(authClientLinkedAccountTestCases)(
    'unlinks the selected $name account',
    ({ linkedAccount, name, setLinkedAccount, unlinkMutation }) => {
      setLinkedAccount(linkedAccount);

      render(<LinkedAccounts />);

      fireEvent.click(
        screen.getByRole('button', { name: `Unlink ${name} account` }),
      );

      expect(unlinkMutation).toHaveBeenCalledWith(
        linkedAccount.accountId,
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
    },
  );

  it('preserves the current personal settings query params when linking GitHub', () => {
    state.searchParams = 'service=github&background=true';

    render(<LinkedAccounts />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Link GitHub account' }),
    );

    expect(mutations.authenticateGitHub).toHaveBeenCalledWith(
      {
        redirect: '/settings?service=github&background=true',
        callbackBackground: 'background',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows the Slack workspace name without the Slack user ID when both are present', () => {
    state.slackInstallation = { teamName: 'Roomote' };
    state.slackAccount = {
      teamName: 'Roomote',
      slackUserId: 'U08ELT3D32A',
    };

    render(<LinkedAccounts />);

    const slackRow = screen.getByText('Slack').closest('div.py-1');
    if (!(slackRow instanceof HTMLElement)) {
      throw new Error('Expected the Slack row container to render.');
    }
    expect(within(slackRow).getByText('Roomote')).toBeInTheDocument();
    expect(screen.queryByText('U08ELT3D32A')).not.toBeInTheDocument();
    expect(screen.queryByText('Roomote · U08ELT3D32A')).not.toBeInTheDocument();
  });

  it('falls back to the Slack user ID when the workspace name is unavailable', () => {
    state.slackInstallation = { teamName: 'Roomote' };
    state.slackAccount = {
      teamName: null,
      slackUserId: 'U08ELT3D32A',
    };

    render(<LinkedAccounts />);

    expect(screen.getByText('U08ELT3D32A')).toBeInTheDocument();
  });

  it('shows the Telegram row with a link action when configured but unlinked', () => {
    state.telegramAccount = { configured: true, mapping: null };

    render(<LinkedAccounts />);

    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Link Telegram account' }),
    ).toBeInTheDocument();
  });

  it('shows the linked Telegram username with an unlink action', () => {
    state.telegramAccount = {
      configured: true,
      mapping: { telegramUserId: '111', telegramUsername: 'ada' },
    };

    render(<LinkedAccounts />);

    expect(screen.getByText('@ada')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Unlink Telegram account' }),
    ).toBeInTheDocument();
  });

  it('hides the Telegram row when Telegram is not configured', () => {
    state.telegramAccount = { configured: false, mapping: null };

    render(<LinkedAccounts />);

    expect(screen.queryByText('Telegram')).not.toBeInTheDocument();
  });
});
