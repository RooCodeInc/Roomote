import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';

const state = vi.hoisted(() => ({
  gitHubInstallations: [{ id: 'gh-1' }],
  gitHubRepositories: [
    {
      id: 'repo-1',
      fullName: 'Roomote/example-app',
      htmlUrl: 'https://github.com/Roomote/example-app',
    },
  ],
  gitLabRepositories: [
    {
      id: 'repo-2',
      fullName: 'Roomote/gitlab-app',
      htmlUrl: 'https://gitlab.com/Roomote/gitlab-app',
    },
  ],
  giteaRepositories: [
    {
      id: 'repo-3',
      fullName: 'Roomote/gitea-app',
      htmlUrl: 'https://git.example.com/Roomote/gitea-app',
    },
  ],
  adoRepositories: [
    {
      id: 'repo-4',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    },
  ],
  bitbucketRepositories: [
    {
      id: 'repo-5',
      fullName: 'acme/bitbucket-app',
      htmlUrl: 'https://bitbucket.org/acme/bitbucket-app',
    },
  ],
  searchParams: '',
  configProviders: [
    { provider: 'github', configSatisfied: true },
    { provider: 'gitlab', configSatisfied: true },
    { provider: 'gitea', configSatisfied: true },
    { provider: 'ado', configSatisfied: true },
    { provider: 'bitbucket', configSatisfied: true },
  ],
}));

const mutations = vi.hoisted(() => ({
  enableGitHub: vi.fn(),
  syncGitHub: vi.fn(),
  createGitHubAppManifest: vi.fn(),
  syncGitLab: vi.fn(),
  syncGitea: vi.fn(),
  syncAdo: vi.fn(),
  syncBitbucket: vi.fn(),
  setPrAction: vi.fn(),
  setGitHubRoomoteMention: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(state.searchParams),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: true }),
}));

vi.mock('@/hooks/github', () => ({
  useGitHubInstallations: () => ({
    data: state.gitHubInstallations,
    isPending: false,
  }),
  useEnableGitHubApp: () => ({
    isPending: false,
    mutate: mutations.enableGitHub,
  }),
  useSyncGitHubInstallations: () => ({
    isPending: false,
    mutate: mutations.syncGitHub,
  }),
  useCreateGitHubAppManifest: () => ({
    isPending: false,
    mutate: mutations.createGitHubAppManifest,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: (input?: {
    sourceControlProvider?: 'github' | 'gitlab' | 'gitea' | 'ado' | 'bitbucket';
  }) => {
    switch (input?.sourceControlProvider) {
      case 'gitlab':
        return {
          data: state.gitLabRepositories,
          isPending: false,
        };
      case 'gitea':
        return {
          data: state.giteaRepositories,
          isPending: false,
        };
      case 'ado':
        return {
          data: state.adoRepositories,
          isPending: false,
        };
      case 'bitbucket':
        return {
          data: state.bitbucketRepositories,
          isPending: false,
        };
      case 'github':
      default:
        return {
          data: state.gitHubRepositories,
          isPending: false,
        };
    }
  },
  useSyncRepositories: (
    provider: 'gitlab' | 'gitea' | 'ado' | 'bitbucket',
  ) => ({
    isPending: false,
    mutate:
      provider === 'gitlab'
        ? mutations.syncGitLab
        : provider === 'gitea'
          ? mutations.syncGitea
          : provider === 'bitbucket'
            ? mutations.syncBitbucket
            : mutations.syncAdo,
  }),
  usePrAction: () => ({
    data: { prAction: 'draft' },
    isLoading: false,
  }),
  useSetPrAction: () => ({
    isPending: false,
    mutate: mutations.setPrAction,
  }),
  useGitHubRoomoteMention: () => ({
    data: { enabled: true },
    isLoading: false,
  }),
  useSetGitHubRoomoteMention: () => ({
    isPending: false,
    mutate: mutations.setGitHubRoomoteMention,
  }),
  useSourceControlConfigStatus: () => ({
    data: {
      selectedProvider: null,
      preselectedProvider: 'github',
      runtimeConfiguredProvider: null,
      runtimeConfiguredProviders: [],
      lockReason: null,
      connectedProvider: null,
      providers: state.configProviders,
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
    },
    isPending: false,
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  BrandIcon: ({
    icon,
    name,
    className,
  }: {
    icon: string;
    name: string;
    className?: string;
  }) => (
    <svg
      aria-hidden="true"
      data-testid={`${icon}-icon`}
      aria-label={name}
      className={className}
    />
  ),
  BookMarked: () => <svg aria-hidden="true" />,
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  ChevronDown: () => <svg aria-hidden="true" />,
  ChevronUp: () => <svg aria-hidden="true" />,
  Code: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  ExternalLink: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  GitBranch: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" data-testid="git-branch-icon" {...props} />
  ),
  GitMerge: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" data-testid="git-merge-icon" {...props} />
  ),
  Github: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" data-testid="github-icon" {...props} />
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Pencil: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Plug: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  RefreshCw: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Sparkles: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Spinner: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div data-testid="pr-action-select" data-value={value}>
      <button
        type="button"
        onClick={() => onValueChange('create')}
        data-testid="pr-action-choose-create"
      >
        choose create
      </button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => <span />,
  Settings2: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
}));

vi.mock('@/components/settings', () => ({
  Section: ({
    icon,
    title,
    action,
    children,
  }: {
    icon?: ReactNode | ((props: SVGProps<SVGSVGElement>) => ReactNode);
    title: ReactNode;
    action?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>
        {typeof icon === 'function' ? icon({}) : icon}
        {title}
      </h2>
      {action}
      {children}
    </section>
  ),
}));

vi.mock('./SourceControlConfigForm', () => ({
  SourceControlConfigForm: ({
    provider,
    showSetupInstructions,
  }: {
    provider: string;
    showSetupInstructions?: boolean;
  }) => (
    <div
      data-testid={`source-control-config-${provider}`}
      data-show-setup-instructions={showSetupInstructions}
    />
  ),
}));

import {
  completeProviderConfigSave,
  getProviderConfigOAuthAuthorizePath,
  SourceControl,
} from './SourceControl';

describe('SourceControl settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.searchParams = '';
    state.gitHubInstallations = [{ id: 'gh-1' }];
    state.gitHubRepositories = [
      {
        id: 'repo-1',
        fullName: 'Roomote/example-app',
        htmlUrl: 'https://github.com/Roomote/example-app',
      },
    ];
    state.gitLabRepositories = [
      {
        id: 'repo-2',
        fullName: 'Roomote/gitlab-app',
        htmlUrl: 'https://gitlab.com/Roomote/gitlab-app',
      },
    ];
    state.giteaRepositories = [
      {
        id: 'repo-3',
        fullName: 'Roomote/gitea-app',
        htmlUrl: 'https://git.example.com/Roomote/gitea-app',
      },
    ];
    state.adoRepositories = [
      {
        id: 'repo-4',
        fullName: 'acme/Platform/backend',
        htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      },
    ];
    state.bitbucketRepositories = [
      {
        id: 'repo-5',
        fullName: 'acme/bitbucket-app',
        htmlUrl: 'https://bitbucket.org/acme/bitbucket-app',
      },
    ];
    state.configProviders = [
      { provider: 'github', configSatisfied: true },
      { provider: 'gitlab', configSatisfied: true },
      { provider: 'gitea', configSatisfied: true },
      { provider: 'ado', configSatisfied: true },
      { provider: 'bitbucket', configSatisfied: true },
    ];
  });

  it('starts OAuth authorization after saving OAuth provider credentials', () => {
    expect(getProviderConfigOAuthAuthorizePath('gitlab')).toBe(
      '/api/source-control/gitlab/oauth/authorize',
    );
    expect(getProviderConfigOAuthAuthorizePath('gitea')).toBe(
      '/api/source-control/gitea/oauth/authorize',
    );
    expect(getProviderConfigOAuthAuthorizePath('bitbucket')).toBe(
      '/api/source-control/bitbucket/oauth/authorize',
    );
    expect(getProviderConfigOAuthAuthorizePath('ado')).toBeNull();
  });

  it.each([
    ['gitea', '/api/source-control/gitea/oauth/authorize'],
    ['gitlab', '/api/source-control/gitlab/oauth/authorize'],
  ] as const)(
    'redirects to OAuth instead of syncing after %s credentials save',
    (provider, authorizePath) => {
      const navigate = vi.fn();
      const sync = vi.fn();

      completeProviderConfigSave({ provider, navigate, sync });

      expect(navigate).toHaveBeenCalledWith(authorizePath);
      expect(sync).not.toHaveBeenCalled();
    },
  );

  it('renders source control providers with repo lists and controls', () => {
    render(<SourceControl />);

    expect(screen.getByText('Source Control Settings')).toBeInTheDocument();
    expect(screen.getAllByText('GitHub')).not.toHaveLength(0);
    expect(
      screen.getByRole('link', { name: 'Roomote/example-app' }),
    ).toHaveAttribute('href', 'https://github.com/Roomote/example-app');
    expect(screen.getAllByText('GitLab')).not.toHaveLength(0);
    expect(
      screen.getByRole('link', { name: 'Roomote/gitlab-app' }),
    ).toHaveAttribute('href', 'https://gitlab.com/Roomote/gitlab-app');
    expect(screen.getAllByText('Gitea')).not.toHaveLength(0);
    expect(
      screen.getByRole('link', { name: 'Roomote/gitea-app' }),
    ).toHaveAttribute('href', 'https://git.example.com/Roomote/gitea-app');
    expect(screen.getAllByText('Azure DevOps')).not.toHaveLength(0);
    expect(
      screen.getByRole('link', { name: 'acme/Platform/backend' }),
    ).toHaveAttribute(
      'href',
      'https://dev.azure.com/acme/Platform/_git/backend',
    );
    expect(screen.getAllByText('Bitbucket Cloud')).not.toHaveLength(0);
    expect(
      screen.getByRole('link', { name: 'acme/bitbucket-app' }),
    ).toHaveAttribute('href', 'https://bitbucket.org/acme/bitbucket-app');
    expect(
      screen.getByRole('button', { name: 'Update GitHub' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh GitHub' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('1. Connect the GitHub app'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('2. Sync repositories')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh GitLab' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh Gitea' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh Azure DevOps' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh Bitbucket Cloud' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('github-icon')).toHaveClass('shrink-0');
    expect(
      screen.getByTestId('source-control-config-github'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('source-control-config-gitlab'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enable GitHub' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disable GitHub' }),
    ).not.toBeInTheDocument();
  });

  it('shows the create GitHub App path when GitHub is not configured', () => {
    state.gitHubInstallations = [];
    state.gitHubRepositories = [];
    state.configProviders = [
      { provider: 'github', configSatisfied: false },
      { provider: 'gitlab', configSatisfied: true },
      { provider: 'gitea', configSatisfied: true },
      { provider: 'ado', configSatisfied: true },
      { provider: 'bitbucket', configSatisfied: true },
    ];

    render(<SourceControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

    expect(
      screen.getByRole('button', { name: 'Create GitHub App' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Enter values manually' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Connect GitHub' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('source-control-config-github'),
    ).not.toBeInTheDocument();
  });

  it('shows the recommendation highlight copy when targeted from a setup link', () => {
    state.searchParams = 'highlight=github';

    render(<SourceControl />);

    expect(document.getElementById('source-control')).toHaveTextContent(
      'Continue with GitHub here. This section is the target for the setup recommendation link.',
    );
  });

  it('requests the regular callback background when updating GitHub from settings', () => {
    state.searchParams = 'tab=source-control';

    render(<SourceControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Update GitHub' }));

    expect(mutations.enableGitHub).toHaveBeenCalledWith(
      {
        redirect: '/settings?tab=source-control',
        callbackBackground: 'background',
      },
      expect.any(Object),
    );
  });

  it('syncs GitLab repositories from the source control section', () => {
    render(<SourceControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh GitLab' }));

    expect(mutations.syncGitLab).toHaveBeenCalledOnce();
  });

  it('syncs Gitea repositories from the source control section', () => {
    render(<SourceControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Gitea' }));

    expect(mutations.syncGitea).toHaveBeenCalledOnce();
  });

  it('syncs Azure DevOps repositories from the source control section', () => {
    render(<SourceControl />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh Azure DevOps' }),
    );

    expect(mutations.syncAdo).toHaveBeenCalledOnce();
  });

  it('syncs Bitbucket repositories from the source control section', () => {
    render(<SourceControl />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh Bitbucket Cloud' }),
    );

    expect(mutations.syncBitbucket).toHaveBeenCalledOnce();
  });

  it('lets admins change the default pull request delivery mode', async () => {
    render(<SourceControl />);

    expect(screen.getByText('Pull request delivery')).toBeInTheDocument();
    expect(screen.getByTestId('pr-action-select')).toHaveAttribute(
      'data-value',
      'draft',
    );

    fireEvent.click(screen.getByTestId('pr-action-choose-create'));

    expect(mutations.setPrAction).toHaveBeenCalledWith(
      'create',
      expect.anything(),
    );
  });

  it('lets admins opt out of the shorter GitHub mention', () => {
    render(<SourceControl />);

    const toggle = screen.getByRole('switch', {
      name: 'Also respond to @roomote',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText(/another Roomote deployment is installed/),
    ).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(mutations.setGitHubRoomoteMention).toHaveBeenCalledWith(
      false,
      expect.anything(),
    );
  });

  it('shows setup links instead of sync for disconnected token providers', () => {
    state.gitLabRepositories = [];
    state.configProviders = [
      { provider: 'github', configSatisfied: true },
      { provider: 'gitlab', configSatisfied: false },
      { provider: 'gitea', configSatisfied: true },
      { provider: 'ado', configSatisfied: true },
      { provider: 'bitbucket', configSatisfied: true },
    ];

    render(<SourceControl />);

    expect(
      screen.queryByRole('button', { name: 'Refresh GitLab' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Set it up' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

    expect(screen.getByTestId('source-control-config-gitlab')).toHaveAttribute(
      'data-show-setup-instructions',
      'true',
    );
    expect(
      screen.queryByRole('button', { name: 'Hide config' }),
    ).not.toBeInTheDocument();
  });

  it('shows ADO setup instructions when required config is not satisfied', () => {
    state.adoRepositories = [];
    state.configProviders = [
      { provider: 'github', configSatisfied: true },
      { provider: 'gitlab', configSatisfied: true },
      { provider: 'gitea', configSatisfied: true },
      // configSatisfied covers required fields only, so ADO stays
      // unconfigured even when the optional ADO_TENANT_ID is satisfied via
      // the R_MICROSOFT_TENANT_ID fallback.
      { provider: 'ado', configSatisfied: false },
      { provider: 'bitbucket', configSatisfied: true },
    ];

    render(<SourceControl />);

    expect(
      screen.queryByRole('button', { name: 'Refresh Azure DevOps' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

    expect(screen.getByTestId('source-control-config-ado')).toHaveAttribute(
      'data-show-setup-instructions',
      'true',
    );
  });

  it('keeps every expanded provider form visible when setting up multiple providers', () => {
    state.giteaRepositories = [];
    state.adoRepositories = [];
    state.configProviders = [
      { provider: 'github', configSatisfied: true },
      { provider: 'gitlab', configSatisfied: true },
      { provider: 'gitea', configSatisfied: false },
      { provider: 'ado', configSatisfied: false },
      { provider: 'bitbucket', configSatisfied: true },
    ];

    render(<SourceControl />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Set it up' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));

    expect(
      screen.getByTestId('source-control-config-gitea'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('source-control-config-ado')).toBeInTheDocument();
  });

  it('shows a success toast when pull request delivery is saved', () => {
    render(<SourceControl />);

    fireEvent.click(screen.getByTestId('pr-action-choose-create'));

    const options = mutations.setPrAction.mock.calls[0]?.[1];
    options?.onSuccess?.();

    expect(toast.success).toHaveBeenCalledWith(
      'Source control settings saved.',
    );
  });
});
