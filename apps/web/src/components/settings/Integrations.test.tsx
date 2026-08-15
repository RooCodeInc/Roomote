import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';

import { MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION } from '@/lib/mcp-tool-errors';

const state = vi.hoisted(() => ({
  integrationsEnabled: true,
  deploymentEnablements: [] as Array<{ mcpId: string; enabled: boolean }>,
  oauthReadiness: [{ mcpId: 'linear', status: 'ready' as const }] as Array<{
    mcpId: string;
    status: 'ready' | 'missing' | 'partial';
  }>,
  userConnections: [] as Array<{
    id?: string;
    mcpId: string;
    authStatus: string;
  }>,
  mcpTools: null as null | {
    mcpId: string;
    toolAccessMode?: 'read_only' | 'read_write' | null;
    tools: Array<{
      name: string;
      description: string | null;
      enabled: boolean;
      availableInReadOnly?: boolean | null;
    }>;
  },
  mcpToolsError: null as Error | null,
  asanaConnection: null as null | {
    authStatus?: string | null;
  },
  notionConnection: null as null | {
    authStatus?: string | null;
  },
  granolaConnection: null as null | {
    authStatus?: string | null;
  },
  elevenLabsConnection: null as null | {
    authStatus?: string | null;
    voiceId?: string;
  },
  grafanaConnection: null as null | {
    authStatus?: string | null;
    baseUrl: string;
  },
  vercelConnection: null as null | {
    authStatus?: string | null;
    defaultTeamIdOrSlug?: string;
  },
  xConnection: null as null | {
    authStatus?: string | null;
  },
  isAdmin: true,
  snowflakeConnection: null as null | {
    authStatus?: string | null;
    authMethod: 'key_pair' | 'password';
    account: string;
    username: string;
    role: string;
    warehouse?: string;
    database?: string;
  },
  linearInstallation: {
    linearOrganizationName: 'Roomote',
  } as null | { linearOrganizationName?: string },
  linearOauthSetup: {
    callbackUrl: 'https://roomote.example/api/mcp-oauth/callback',
    webhookUrl: 'https://roomote.example/api/webhooks/linear',
    manifestUrl: 'https://linear.app/settings/api/applications/new?manifest=x',
    fields: {
      clientId: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
      clientSecret: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
      webhookSecret: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
    },
  },
  linearRedirectPath: '',
  searchParams: '',
}));

const { mutations, selectMock, radioMock } = vi.hoisted(() => ({
  mutations: {
    connectLinear: vi.fn(),
    disconnectLinear: vi.fn(),
    setDeploymentEnabled: vi.fn(),
    connectMcp: vi.fn(),
    disconnectMcp: vi.fn(),
    setDisabledTools: vi.fn(),
    saveAsanaConnection: vi.fn(),
    saveNotionConnection: vi.fn(),
    saveGranolaConnection: vi.fn(),
    saveElevenLabsConnection: vi.fn(),
    saveGrafanaConnection: vi.fn(),
    saveSnowflakeConnection: vi.fn(),
    saveVercelConnection: vi.fn(),
    saveXConnection: vi.fn(),
    saveLinearOauthSetup: vi.fn(),
    removeLinearOauthSetup: vi.fn(),
  },
  selectMock: {
    latestOnValueChange: null as null | ((value: string) => void),
  },
  radioMock: {
    currentValue: null as string | null,
    latestOnValueChange: null as null | ((value: string) => void),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: string[]; enabled?: boolean }) => {
    void options;
    return {
      data: undefined,
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({
    setQueryData: vi.fn(),
  }),
}));

function cloneMcpToolsData() {
  if (!state.mcpTools) {
    return null;
  }

  return {
    ...state.mcpTools,
    tools: state.mcpTools.tools.map((tool) => ({ ...tool })),
  };
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/integrations',
  useSearchParams: () => new URLSearchParams(state.searchParams),
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

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    isAdmin: state.isAdmin,
  }),
}));

vi.mock('@/hooks/linear', () => ({
  useLinearInstallation: () => ({
    data: state.linearInstallation,
    isPending: false,
  }),
  useConnectLinear: (redirectPath: string) => {
    state.linearRedirectPath = redirectPath;
    return {
      isPending: false,
      mutate: mutations.connectLinear,
    };
  },
  useDisconnectLinear: () => ({
    isPending: false,
    mutate: mutations.disconnectLinear,
  }),
  useLinearOauthSetup: () => ({
    data: state.linearOauthSetup,
    isPending: false,
  }),
  useSaveLinearOauthSetup: () => ({
    isPending: false,
    mutate: mutations.saveLinearOauthSetup,
  }),
  useRemoveLinearOauthSetup: () => ({
    isPending: false,
    mutate: mutations.removeLinearOauthSetup,
  }),
}));

vi.mock('@/hooks/mcp-connections', () => ({
  useCuratedIntegrationsAvailability: () => ({
    data: { enabled: state.integrationsEnabled },
  }),
  useDeploymentMcpEnablements: () => ({
    data: state.deploymentEnablements,
  }),
  useMcpOauthReadiness: () => ({
    data: state.oauthReadiness,
    isPending: false,
  }),
  useUserMcpConnections: () => ({
    data: state.userConnections,
    isPending: false,
  }),
  useMcpConnectionTools: () => ({
    data: cloneMcpToolsData(),
    isPending: false,
    error: state.mcpToolsError,
    isError: state.mcpToolsError != null,
    status:
      state.mcpToolsError == null ? ('success' as const) : ('error' as const),
  }),
  useSetDeploymentMcpEnabled: () => ({
    isPending: false,
    mutate: mutations.setDeploymentEnabled,
    variables: undefined,
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
  useSetDisabledMcpTools: () => ({
    isPending: false,
    mutate: mutations.setDisabledTools,
  }),
  useSaveAsanaConnection: () => ({
    isPending: false,
    mutate: mutations.saveAsanaConnection,
  }),
  useAsanaConnection: () => ({
    data: state.asanaConnection,
    isPending: false,
  }),
  useSaveNotionConnection: () => ({
    isPending: false,
    mutate: mutations.saveNotionConnection,
  }),
  useNotionConnection: () => ({
    data: state.notionConnection,
    isPending: false,
  }),
  useSaveGranolaConnection: () => ({
    isPending: false,
    mutate: mutations.saveGranolaConnection,
  }),
  useGranolaConnection: () => ({
    data: state.granolaConnection,
    isPending: false,
  }),
  useSaveElevenLabsConnection: () => ({
    isPending: false,
    mutate: mutations.saveElevenLabsConnection,
  }),
  useElevenLabsConnection: () => ({
    data: state.elevenLabsConnection,
    isPending: false,
  }),
  useSaveGrafanaConnection: () => ({
    isPending: false,
    mutate: mutations.saveGrafanaConnection,
  }),
  useGrafanaConnection: () => ({
    data: state.grafanaConnection,
    isPending: false,
  }),
  useSaveSnowflakeConnection: () => ({
    isPending: false,
    mutate: mutations.saveSnowflakeConnection,
  }),
  useSnowflakeConnection: () => ({
    data: state.snowflakeConnection,
    isPending: false,
  }),
  useSaveVercelConnection: () => ({
    isPending: false,
    mutate: mutations.saveVercelConnection,
  }),
  useVercelConnection: () => ({
    data: state.vercelConnection,
    isPending: false,
  }),
  useSaveXConnection: () => ({
    isPending: false,
    mutate: mutations.saveXConnection,
  }),
  useXConnection: () => ({
    data: state.xConnection,
    isPending: false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({}),
}));

// Custom MCP servers are covered by their own suite; this one exercises the
// catalog cards, so stub the hook that feeds custom cards into the grids.
vi.mock('./CustomMcpServers', () => ({
  useCustomMcpServers: () => ({
    isEnabled: true,
    items: [],
    openAddDialog: vi.fn(),
    dialogs: null,
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div data-slot="alert-description" className={className}>
      {children}
    </div>
  ),
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  BrandIcon: ({ name }: { name: string }) => (
    <svg aria-label={name} role="img" />
  ),
  Button: ({
    children,
    asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    asChild ? (
      children
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  Card: ({
    children,
    ...props
  }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  Check: () => <svg aria-hidden="true" />,
  Copy: () => <svg aria-hidden="true" />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
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
  Eye: () => <svg aria-hidden="true" />,
  EyeOff: () => <svg aria-hidden="true" />,
  EthernetPort: () => <svg aria-hidden="true" />,
  ExternalLink: () => <svg aria-hidden="true" />,
  Info: () => <svg aria-hidden="true" />,
  InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
  Input: ({
    secret: _secret,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    secret?: boolean;
  }) => <input {...props} />,
  Label: ({ children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  LinearLogo: () => <svg aria-hidden="true" />,
  Pencil: () => <svg aria-hidden="true" />,
  Plus: () => <svg aria-hidden="true" data-icon="plus" />,
  PlugIcon: () => <svg aria-hidden="true" />,
  RefreshCw: ({ className }: { className?: string }) => (
    <svg aria-hidden="true" className={className} data-icon="refresh-cw" />
  ),
  RadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => {
    radioMock.currentValue = value;
    radioMock.latestOnValueChange = onValueChange;
    return <div role="radiogroup">{children}</div>;
  },
  RadioGroupItem: ({ id, value }: { id: string; value: string }) => (
    <input
      id={id}
      type="radio"
      value={value}
      checked={radioMock.currentValue === value}
      onChange={() => radioMock.latestOnValueChange?.(value)}
    />
  ),
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => {
    selectMock.latestOnValueChange = onValueChange;
    return <div>{children}</div>;
  },
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    disabled,
    value,
  }: {
    children: ReactNode;
    disabled?: boolean;
    value: string;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => selectMock.latestOnValueChange?.(value)}
    >
      {children}
    </button>
  ),
  SelectTrigger: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Settings2: () => <svg aria-hidden="true" data-icon="settings-2" />,
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className}>loading</div>
  ),
  Spinner: () => <span>loading</span>,
  Star: () => <svg aria-hidden="true" />,
  Trash: () => <svg aria-hidden="true" />,
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      data-checked={checked ? 'true' : 'false'}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  TriangleAlert: ({ className }: { className?: string }) => (
    <svg aria-hidden="true" className={className} data-icon="triangle-alert" />
  ),
  ToggleLeft: () => <svg aria-hidden="true" />,
  ToggleRight: () => <svg aria-hidden="true" />,
  X: () => <svg aria-hidden="true" />,
}));

import { Integrations, sortIntegrationItems } from './Integrations';
import { splitIntegrationItems } from './integration-card';

describe('Integrations settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/settings/integrations');
    state.deploymentEnablements = [];
    state.integrationsEnabled = true;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'ready' }];
    state.userConnections = [];
    state.mcpTools = null;
    state.mcpToolsError = null;
    state.linearInstallation = {
      linearOrganizationName: 'Roomote',
    };
    state.linearRedirectPath = '';
    state.asanaConnection = null;
    state.notionConnection = null;
    state.granolaConnection = null;
    state.grafanaConnection = null;
    state.vercelConnection = null;
    state.xConnection = null;
    state.isAdmin = true;
    state.snowflakeConnection = null;
    state.searchParams = '';
    state.linearOauthSetup.fields = {
      clientId: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
      clientSecret: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
      webhookSecret: {
        configured: false,
        managedByEnvironment: false,
        savedInRoomote: false,
      },
    };
  });

  it('returns Linear OAuth to a service-specific integrations URL', () => {
    render(<Integrations />);

    expect(state.linearRedirectPath).toBe(
      '/settings/integrations?service=linear',
    );
  });

  it('uses the settings action for missing Linear OAuth setup', () => {
    state.linearInstallation = null;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'missing' }];

    render(<Integrations />);

    const linearCard = screen
      .getByRole('heading', { name: 'Linear' })
      .closest('[id="integration-linear"]');

    expect(linearCard).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Set up Linear' }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole('button', { name: 'Set up Linear' })
        .querySelector('[data-icon="settings-2"]'),
    ).toBeInTheDocument();
  });

  it('distinguishes incomplete Linear OAuth setup for admins', () => {
    state.linearInstallation = null;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'partial' }];

    render(<Integrations />);

    const linearCard = screen
      .getByRole('heading', { name: 'Linear' })
      .closest('[id="integration-linear"]');

    expect(linearCard).toHaveTextContent('Configuration incomplete.');
  });

  it('asks non-admins to contact an administrator when OAuth is unavailable', () => {
    state.isAdmin = false;
    state.linearInstallation = null;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'missing' }];

    render(<Integrations />);

    expect(
      screen.getByText('Not configured. Ask an administrator to set it up.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set up Linear' }),
    ).not.toBeInTheDocument();
  });

  it('opens the guided Linear OAuth setup for admins', () => {
    state.linearInstallation = null;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'missing' }];

    render(<Integrations />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up Linear' }));

    expect(
      screen.getByRole('heading', { name: 'Set up Linear' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create the app' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('2', { exact: true })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Create a Linear app.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Copy the app credentials.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Callback URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Webhook URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Client ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Webhook signing secret')).toBeInTheDocument();
  });

  it('offers administrators configuration access after Linear is configured', () => {
    state.linearInstallation = null;
    state.oauthReadiness = [{ mcpId: 'linear', status: 'ready' }];

    render(<Integrations />);

    expect(
      screen.queryByRole('button', { name: 'Set up Linear' }),
    ).not.toBeInTheDocument();
    const configureButton = screen.getByRole('button', {
      name: 'Configure Linear',
    });
    expect(configureButton).toBeInTheDocument();
    expect(configureButton).not.toHaveTextContent('Configure');
    expect(
      screen.getByRole('button', { name: 'Connect Linear' }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole('button', { name: 'Connect Linear' })
        .querySelector('[data-icon="plus"]'),
    ).toBeInTheDocument();
  });

  it('does not offer Linear credential configuration to non-admins', () => {
    state.isAdmin = false;

    render(<Integrations />);

    expect(
      screen.queryByRole('button', { name: 'Configure Linear' }),
    ).not.toBeInTheDocument();
  });

  it('removes saved Linear credentials after confirmation', () => {
    state.linearInstallation = null;
    state.linearOauthSetup.fields = {
      clientId: {
        configured: true,
        managedByEnvironment: false,
        savedInRoomote: true,
      },
      clientSecret: {
        configured: true,
        managedByEnvironment: false,
        savedInRoomote: true,
      },
      webhookSecret: {
        configured: true,
        managedByEnvironment: false,
        savedInRoomote: true,
      },
    };
    mutations.removeLinearOauthSetup.mockImplementation((_variables, options) =>
      options?.onSuccess?.({ success: true }),
    );

    render(<Integrations />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure Linear' }));

    expect(
      screen.getByRole('heading', { name: 'Configure Linear' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Update the app credentials.' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open Linear app creation' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove saved credentials' }),
    );
    expect(
      screen.getByRole('heading', {
        name: 'Remove saved Linear credentials?',
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove credentials' }));

    expect(mutations.removeLinearOauthSetup).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      'Saved Linear OAuth credentials removed.',
    );
  });

  it('does not offer to remove environment-managed Linear credentials', () => {
    state.linearInstallation = null;
    state.linearOauthSetup.fields = {
      clientId: {
        configured: true,
        managedByEnvironment: true,
        savedInRoomote: false,
      },
      clientSecret: {
        configured: true,
        managedByEnvironment: true,
        savedInRoomote: false,
      },
      webhookSecret: {
        configured: true,
        managedByEnvironment: true,
        savedInRoomote: false,
      },
    };

    render(<Integrations />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure Linear' }));

    expect(
      screen.queryByRole('button', { name: 'Remove saved credentials' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText('Managed by the deployment environment.'),
    ).toHaveLength(3);
  });

  it('offers setup for a legacy workspace when deployment credentials are missing', () => {
    state.linearInstallation = { linearOrganizationName: 'Legacy workspace' };
    state.oauthReadiness = [{ mcpId: 'linear', status: 'missing' }];

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Set up Linear' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disable Linear' }),
    ).not.toBeInTheDocument();
  });

  it('lets administrators reconnect a configured Linear workspace', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Linear' }));

    expect(mutations.connectLinear).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('surfaces the server error when starting Linear fails', () => {
    state.linearInstallation = null;
    mutations.connectLinear.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('Linear OAuth setup changed. Try again.'));
    });

    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));

    expect(toast.error).toHaveBeenCalledWith(
      'Linear OAuth setup changed. Try again.',
    );
  });

  it('sorts integrations alphabetically and splits enabled, configured, and available', () => {
    const sorted = sortIntegrationItems([
      { id: 'sentry', name: 'Sentry', enabled: false },
      { id: 'linear', name: 'Linear', enabled: true },
      { id: 'notion', name: 'Notion', enabled: false, configured: true },
      {
        id: 'custom-oauth',
        name: 'Custom OAuth',
        enabled: true,
        connected: false,
        configured: true,
      },
      { id: 'asana', name: 'Asana', enabled: false },
    ]);
    const grouped = splitIntegrationItems(sorted);

    expect(grouped.installed.map((item) => item.name)).toEqual(['Linear']);
    expect(grouped.configured.map((item) => item.name)).toEqual([
      'Custom OAuth',
      'Notion',
    ]);
    expect(grouped.available.map((item) => item.name)).toEqual([
      'Asana',
      'Sentry',
    ]);
  });

  it('shows configured integrations separately and an empty connected state', () => {
    state.linearInstallation = null;

    render(<Integrations />);

    const connectedSection = screen
      .getByRole('heading', { name: 'Connected' })
      .closest('section');
    const configuredSection = screen
      .getByRole('heading', { name: 'Configured' })
      .closest('section');

    expect(connectedSection).toHaveTextContent(
      "You haven't connected any integrations yet.",
    );
    expect(
      within(configuredSection as HTMLElement).getByRole('heading', {
        name: 'Linear',
      }),
    ).toBeInTheDocument();
  });

  it('highlights a selected integration above alphabetical order', () => {
    const sorted = sortIntegrationItems(
      [
        { id: 'sentry', name: 'Sentry', enabled: false },
        { id: 'notion', name: 'Notion', enabled: false },
        { id: 'asana', name: 'Asana', enabled: false },
      ],
      'notion',
    );

    expect(sorted.map((item) => item.id)).toEqual([
      'notion',
      'asana',
      'sentry',
    ]);
  });

  it('renders connected and available sections with compact action buttons', () => {
    render(<Integrations />);

    const connectedSection = screen
      .getByRole('heading', { name: 'Connected' })
      .closest('section');
    const availableSection = screen
      .getByRole('heading', { name: 'Available' })
      .closest('section');
    expect(connectedSection).not.toBeNull();
    expect(availableSection).not.toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Configured' }),
    ).not.toBeInTheDocument();

    expect(
      within(connectedSection as HTMLElement)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Linear']);
    expect(
      within(availableSection as HTMLElement)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Asana',
      'Better Stack',
      'Braintrust',
      'ElevenLabs',
      'Grafana',
      'Granola',
      'Jira',
      'monday.com',
      'Neon',
      'Notion',
      'PostHog',
      'Pylon',
      'Railway',
      'Resend',
      'Sentry',
      'Snowflake',
      'Supabase',
      'Supermemory',
      'Vercel',
      'X',
      'Zero',
    ]);
    expect(
      screen.getAllByText('First-class integration').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('MCP-based integration').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByText('Connected once for everyone in your workspace.'),
    ).not.toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: 'Disable Linear' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Better Stack' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable PostHog' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Pylon' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Railway' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Resend' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Inspect and manage shared email infrastructure through Resend from Roomote tasks.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Jira' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect and enable Sentry' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Asana' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Grafana' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Granola' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Snowflake' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Vercel' }),
    ).toBeInTheDocument();
  });

  it('shows operator policy instead of integration controls when disabled', () => {
    state.integrationsEnabled = false;

    render(<Integrations />);

    expect(
      screen.getByText('Integrations disabled by deployment operator'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Connected' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disable Linear' }),
    ).not.toBeInTheDocument();
  });

  it('connects and enables an org-scoped MCP from the integrations page', () => {
    render(<Integrations />);

    screen.getByRole('button', { name: 'Connect and enable Pylon' }).click();

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'pylon', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('connects and enables PostHog from the integrations page as a workspace-scoped MCP', () => {
    render(<Integrations />);

    screen.getByRole('button', { name: 'Connect and enable PostHog' }).click();

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'posthog', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('starts Better Stack from the workspace-scoped connect flow', () => {
    render(<Integrations />);

    screen
      .getByRole('button', { name: 'Connect and enable Better Stack' })
      .click();

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'betterstack', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('starts Pylon from the workspace-scoped connect flow', () => {
    render(<Integrations />);

    screen.getByRole('button', { name: 'Connect and enable Pylon' }).click();

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'pylon', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('starts Railway from the workspace-scoped connect flow', () => {
    render(<Integrations />);

    screen.getByRole('button', { name: 'Connect and enable Railway' }).click();

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'railway', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('starts Jira from the workspace-scoped connect flow', () => {
    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Connect and enable Jira' }),
    );

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'jira', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('starts Sentry from the workspace-scoped connect flow', () => {
    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Connect and enable Sentry' }),
    );

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'sentry', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('keeps the disable toast unchanged for Jira after it is workspace-scoped', () => {
    state.deploymentEnablements = [{ mcpId: 'jira', enabled: true }];
    mutations.setDeploymentEnabled.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });

    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Disable Jira' }));

    expect(mutations.setDeploymentEnabled).toHaveBeenCalledWith(
      { mcpId: 'jira', enabled: false },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Jira disabled for this deployment.',
    );
  });

  it('surfaces the highlighted integration from the URL', () => {
    state.searchParams = 'highlight=sentry-mcp';

    render(<Integrations />);

    expect(
      screen
        .getByRole('heading', { name: 'Sentry' })
        .closest('[data-highlighted="true"]'),
    ).not.toBeNull();
  });

  it('shows the confirmation dialog when a highlighted integration is not enabled', () => {
    state.searchParams = 'highlight=pylon';

    render(<Integrations />);

    expect(
      screen.getByRole('heading', { name: 'Enable Pylon?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote will be able to inspect customer issues, message history, and account context.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the Jira confirmation dialog copy for highlighted integrations', () => {
    state.searchParams = 'highlight=jira';

    render(<Integrations />);

    expect(
      screen.getByRole('heading', { name: 'Enable Jira?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote will be able to inspect Jira issues, workflows, and JQL search results.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the monday.com confirmation dialog copy for highlighted integrations', () => {
    state.searchParams = 'highlight=monday';

    render(<Integrations />);

    expect(
      screen.getByRole('heading', { name: 'Enable monday.com?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote will be able to inspect monday.com boards, items, updates, docs, and workspace context.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the Granola confirmation dialog copy for highlighted integrations', () => {
    state.searchParams = 'highlight=granola';

    render(<Integrations />);

    expect(
      screen.getByRole('heading', { name: 'Enable Granola?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote will use one deployment-wide Granola connection to browse meeting notes, transcripts, decisions, and action items.',
      ),
    ).toBeInTheDocument();
  });

  it('does not show the confirmation dialog for an enabled highlighted integration', () => {
    state.searchParams = 'highlight=sentry-mcp';
    state.deploymentEnablements = [{ mcpId: 'sentry', enabled: true }];
    state.userConnections = [
      { id: 'conn-sentry', mcpId: 'sentry', authStatus: 'authenticated' },
    ];

    render(<Integrations />);

    expect(
      screen.queryByRole('heading', { name: 'Enable Sentry?' }),
    ).not.toBeInTheDocument();
  });

  it('runs the highlighted Sentry action when the connect button is clicked', () => {
    state.searchParams = 'highlight=sentry-mcp';

    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Connect and enable Sentry' }),
    );

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'sentry', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('uses the Sentry MCP deep link for non-admin Slack setup prompts', () => {
    state.isAdmin = false;
    state.searchParams = 'highlight=sentry-mcp&source=slack-mcp-interrupt';

    render(<Integrations />);

    expect(
      screen.queryByRole('heading', { name: 'Enable Sentry?' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Connect and enable Sentry' }),
    );

    expect(mutations.connectMcp).toHaveBeenCalledWith(
      { mcpId: 'sentry', redirectTo: '/settings/integrations' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('does not show a deep-link dialog when the highlighted integration has no action', () => {
    state.searchParams = 'service=sentry&source=slack-mcp-interrupt';

    render(<Integrations />);

    expect(
      screen.queryByRole('heading', { name: 'Enable Sentry?' }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole('heading', { name: 'Sentry' })
        .closest('[data-highlighted="true"]'),
    ).toBeNull();
  });

  it('dismisses the dialog when Not now is clicked', () => {
    state.searchParams =
      'highlight=pylon&source=slack-manager-integration-setup';
    const replaceState = vi.spyOn(window.history, 'replaceState');
    window.history.replaceState(
      null,
      '',
      '/settings/integrations?highlight=pylon&source=slack-manager-integration-setup',
    );

    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(
      screen.queryByRole('heading', { name: 'Enable Pylon?' }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole('heading', { name: 'Pylon' })
        .closest('[data-highlighted="true"]'),
    ).toBeNull();
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/settings/integrations?source=slack-manager-integration-setup',
    );
  });

  it('does not restore cleared OAuth result parameters when dismissing Linear', () => {
    state.searchParams = 'service=linear&mcp=error&reason=access_denied';
    const replaceState = vi.spyOn(window.history, 'replaceState');
    state.linearInstallation = null;

    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/settings/integrations',
    );
  });

  it('shows workspace connection status for an enabled org-scoped MCP', () => {
    state.deploymentEnablements = [{ mcpId: 'pylon', enabled: true }];
    state.userConnections = [{ mcpId: 'pylon', authStatus: 'authenticated' }];

    render(<Integrations />);

    expect(
      screen.queryByRole('button', {
        name: 'Reconnect Pylon workspace account',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Enable Pylon so this deployment can access customer issues, message history, and account context from Roomote tasks.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Connected once for everyone in your workspace.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disable Pylon' }),
    ).toBeInTheDocument();
  });

  it('shows a reconnect warning with icons for an enabled org-scoped MCP that needs attention', () => {
    state.deploymentEnablements = [{ mcpId: 'sentry', enabled: true }];
    state.userConnections = [{ mcpId: 'sentry', authStatus: 'pending' }];

    render(<Integrations />);

    const sentryCard = screen
      .getByRole('heading', { name: 'Sentry' })
      .closest('[id^="integration-"]');

    expect(
      screen.getByText(
        'Connection needs attention. Reconnect it here to keep it available to the workspace.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Reconnect Sentry workspace account',
      }),
    ).toBeInTheDocument();
    expect(
      sentryCard?.querySelector('svg[data-icon="triangle-alert"]'),
    ).not.toBeNull();
    expect(
      screen
        .getByRole('button', {
          name: 'Reconnect Sentry workspace account',
        })
        .querySelector('svg[data-icon="refresh-cw"]'),
    ).not.toBeNull();
  });

  it('opens the manage tools dialog with prettified tool labels', () => {
    state.deploymentEnablements = [{ mcpId: 'sentry', enabled: true }];
    state.userConnections = [
      { id: 'conn-sentry', mcpId: 'sentry', authStatus: 'authenticated' },
    ];
    state.mcpTools = {
      mcpId: 'sentry',
      tools: [
        {
          name: 'get_sentry_resource',
          description: 'Inspect a Sentry resource',
          enabled: true,
        },
      ],
    };

    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Sentry tools' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Manage Sentry tools' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disable get_sentry_resource' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Get Sentry Resource')).toHaveAttribute(
      'for',
      expect.stringMatching(/^mcp-tool-sentry-/),
    );
    expect(screen.queryByText('get_sentry_resource')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Inspect a Sentry resource'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save changes' }),
    ).toBeInTheDocument();
  });

  it('links user-scoped MCP tool authentication errors to personal settings in a new tab', () => {
    state.deploymentEnablements = [{ mcpId: 'monday', enabled: true }];
    state.mcpToolsError = new Error(
      MCP_TOOL_CATALOG_REQUIRES_PERSONAL_CONNECTION,
    );

    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Manage monday.com tools' }),
    );

    const link = screen.getByRole('link', { name: 'personal settings' });

    expect(link).toHaveAttribute('href', '/settings/personal');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.closest('[data-slot="alert-description"]')).toHaveTextContent(
      'link your monday.com account in personal settings',
    );
    expect(
      screen.queryByRole('button', { name: 'Save changes' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
  });

  it('shows admin tool management for enabled user-scoped MCPs without a connection row', () => {
    state.deploymentEnablements = [{ mcpId: 'monday', enabled: true }];

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Manage monday.com tools' }),
    ).toBeInTheDocument();
  });

  it('lets admins opt a deployment-wide Notion connection into read-write access', () => {
    state.deploymentEnablements = [{ mcpId: 'notion', enabled: true }];
    state.userConnections = [
      { id: 'conn-notion', mcpId: 'notion', authStatus: 'authenticated' },
    ];
    state.notionConnection = { authStatus: 'authenticated' };
    state.mcpTools = {
      mcpId: 'notion',
      toolAccessMode: 'read_only',
      tools: [
        {
          name: 'notion-fetch',
          description: 'Fetch a Notion page',
          enabled: true,
          availableInReadOnly: true,
        },
        {
          name: 'notion-update-page',
          description: 'Update a Notion page',
          enabled: true,
          availableInReadOnly: false,
        },
      ],
    };

    render(<Integrations />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Notion tools' }),
    );

    expect(screen.getByLabelText('Read only (recommended)')).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Enable notion-update-page' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Read and write'));

    expect(
      screen.getByRole('button', { name: 'Disable notion-update-page' }),
    ).toBeEnabled();

    expect(
      screen.getByText(
        "Read and write access remains limited to pages and data sources explicitly shared with the deployment's Notion internal integration.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mutations.setDisabledTools).toHaveBeenCalledWith(
      {
        mcpId: 'notion',
        disabledTools: [],
        toolAccessMode: 'read_write',
      },
      expect.any(Object),
    );
  });

  it('opens the Snowflake credential dialog from the integrations page', () => {
    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Snowflake' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Connect Snowflake' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Account identifier')).toBeInTheDocument();
    expect(screen.getByLabelText('Private Key (PEM)')).toHaveAttribute(
      'placeholder',
      '-----BEGIN PRIVATE KEY-----',
    );
    expect(
      screen.getByLabelText('Private Key Passphrase (optional)'),
    ).toBeInTheDocument();
  });

  it('opens the Asana credential dialog from the integrations page', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Asana' }));

    const accessTokenInput = screen.getByLabelText('Asana Access Token');

    expect(
      screen.getByRole('heading', { name: 'Connect Asana' }),
    ).toBeInTheDocument();
    expect(accessTokenInput).toBeInTheDocument();
    expect(accessTokenInput.tagName).toBe('INPUT');
    expect(
      screen.getByText(
        /Works with both Personal Access Tokens and Service Account tokens/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'app.asana.com/0/my-apps' }),
    ).toHaveAttribute('href', 'https://app.asana.com/0/my-apps');
  });

  it('opens the Notion internal integration dialog with page-sharing guidance', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Notion' }));

    expect(
      screen.getByRole('heading', { name: 'Connect Notion' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Internal integration secret'),
    ).toHaveAttribute('type', 'password');
    expect(
      screen.getByText(
        /share only the approved pages or data sources with it/i,
      ),
    ).toBeInTheDocument();
  });

  it('opens the Grafana credential dialog from the integrations page', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Grafana' }));

    expect(
      screen.getByRole('heading', { name: 'Connect Grafana' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Grafana URL')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Grafana Service Account Token'),
    ).toBeInTheDocument();
  });

  it('opens the Granola API-key dialog with deployment access guidance', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Granola' }));

    expect(
      screen.getByRole('heading', { name: 'Connect Granola' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Granola API Key')).toBeInTheDocument();
    expect(
      screen.getByText(
        /We strongly recommend a Granola workspace API key\. Workspace keys can read public notes and spaces where "Allow Granola API access" is enabled\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'You can also use a personal API key with Public notes selected and Personal notes left unchecked.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Store a Granola API key for this deployment. The secret stays encrypted server-side.',
      ),
    ).toBeInTheDocument();
  });

  it('submits an Asana token from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Asana' }));
    fireEvent.change(screen.getByLabelText('Asana Access Token'), {
      target: { value: 'asana-secret-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Asana' }));

    expect(mutations.saveAsanaConnection).toHaveBeenCalledWith(
      {
        accessToken: 'asana-secret-token',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('submits a Notion internal integration secret', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Notion' }));
    fireEvent.change(screen.getByLabelText('Internal integration secret'), {
      target: { value: 'ntn_restricted-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }));

    expect(mutations.saveNotionConnection).toHaveBeenCalledWith(
      { internalIntegrationSecret: 'ntn_restricted-secret' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('submits a Grafana connection from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Grafana' }));
    fireEvent.change(screen.getByLabelText('Grafana URL'), {
      target: { value: 'https://grafana.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Grafana Service Account Token'), {
      target: { value: 'glsa_secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Grafana' }));

    expect(mutations.saveGrafanaConnection).toHaveBeenCalledWith(
      {
        baseUrl: 'https://grafana.example.com',
        serviceAccountToken: 'glsa_secret',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('submits a trimmed Granola API key from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Granola' }));
    fireEvent.change(screen.getByLabelText('Granola API Key'), {
      target: { value: '  granola-secret-key  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Granola' }));

    expect(mutations.saveGranolaConnection).toHaveBeenCalledWith(
      {
        apiKey: 'granola-secret-key',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows Asana connected controls and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'asana', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'asana',
        authStatus: 'authenticated',
      },
    ];
    state.asanaConnection = {
      authStatus: 'authenticated',
    };

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Edit Asana connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect Asana' }),
    ).toBeInTheDocument();

    const asanaCard = screen
      .getByRole('heading', { name: 'Asana' })
      .closest('#integration-asana');
    expect(asanaCard).not.toBeNull();
    expect(
      within(asanaCard as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Disconnect Asana', 'Edit Asana connection']);

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Asana connection' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Edit Asana' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Asana Access Token')).toHaveValue('');
    expect(
      screen.getByText('Leave blank to keep the existing token.'),
    ).toBeInTheDocument();
  });

  it('keeps the Asana card read-only for non-admins when disconnected', () => {
    state.isAdmin = false;

    render(<Integrations />);

    expect(
      screen.queryByRole('button', { name: 'Configure Asana' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Asana')).toBeInTheDocument();
  });

  it('keeps the Asana card read-only for non-admins when connected', () => {
    state.isAdmin = false;
    state.deploymentEnablements = [{ mcpId: 'asana', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'asana',
        authStatus: 'authenticated',
      },
    ];

    render(<Integrations />);

    expect(
      screen.queryByRole('button', { name: 'Edit Asana connection' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disconnect Asana' }),
    ).not.toBeInTheDocument();
  });

  it('shows Grafana connected controls and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'grafana', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'grafana',
        authStatus: 'authenticated',
      },
    ];
    state.grafanaConnection = {
      authStatus: 'authenticated',
      baseUrl: 'https://acme.grafana.net',
    };

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Edit Grafana connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect Grafana' }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Grafana connection' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Edit Grafana' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Grafana URL')).toHaveValue(
      'https://acme.grafana.net',
    );
    expect(screen.getByLabelText('Grafana Service Account Token')).toHaveValue(
      '',
    );
    expect(
      screen.getByText('Leave blank to keep the existing token.'),
    ).toBeInTheDocument();
  });

  it('shows native Granola connected controls and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'granola', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'granola',
        authStatus: 'authenticated',
      },
    ];
    state.granolaConnection = {
      authStatus: 'authenticated',
    };

    render(<Integrations />);

    const granolaCard = screen
      .getByRole('heading', { name: 'Granola' })
      .closest('#integration-granola');
    expect(granolaCard).not.toBeNull();
    expect(
      within(granolaCard as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Disconnect Granola', 'Edit Granola connection']);
    expect(
      screen.queryByRole('button', { name: 'Manage Granola tools' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Granola' }));
    expect(mutations.disconnectMcp).toHaveBeenCalledWith(
      { mcpId: 'granola' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Granola connection' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Edit Granola' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Granola API Key')).toHaveValue('');
    expect(
      screen.getByText('Leave blank to keep the existing API key.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mutations.saveGranolaConnection).toHaveBeenCalledWith(
      { apiKey: '' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('opens the Vercel credential dialog from the integrations page', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Vercel' }));

    expect(
      screen.getByRole('heading', { name: 'Connect Vercel' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Vercel Access Token')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Default Team ID or Slug (optional)'),
    ).toBeInTheDocument();
  });

  it('submits a Vercel token from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure Vercel' }));
    fireEvent.change(screen.getByLabelText('Vercel Access Token'), {
      target: { value: 'vercel_secret' },
    });
    fireEvent.change(
      screen.getByLabelText('Default Team ID or Slug (optional)'),
      {
        target: { value: 'acme-team' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect Vercel' }));

    expect(mutations.saveVercelConnection).toHaveBeenCalledWith(
      {
        accessToken: 'vercel_secret',
        defaultTeamIdOrSlug: 'acme-team',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows Vercel connected controls and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'vercel', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'vercel',
        authStatus: 'authenticated',
      },
    ];
    state.vercelConnection = {
      authStatus: 'authenticated',
      defaultTeamIdOrSlug: 'team_123',
    };

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Edit Vercel connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect Vercel' }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Vercel connection' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Edit Vercel' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Vercel Access Token')).toHaveValue('');
    expect(
      screen.getByLabelText('Default Team ID or Slug (optional)'),
    ).toHaveValue('team_123');
    expect(
      screen.getByText('Leave blank to keep the existing token.'),
    ).toBeInTheDocument();
  });

  it('submits an X bearer token from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure X' }));

    expect(
      screen.getByRole('heading', { name: 'Connect X' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'console.x.com' })).toHaveAttribute(
      'href',
      'https://console.x.com/',
    );

    fireEvent.change(screen.getByLabelText('X App-only Bearer Token'), {
      target: { value: 'AAAA-x-app-only-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect X' }));

    expect(mutations.saveXConnection).toHaveBeenCalledWith(
      {
        bearerToken: 'AAAA-x-app-only-token',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows X connected controls and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'x', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'x',
        authStatus: 'authenticated',
      },
    ];
    state.xConnection = {
      authStatus: 'authenticated',
    };

    render(<Integrations />);

    expect(
      screen.getByRole('button', { name: 'Edit X connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect X' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit X connection' }));

    expect(screen.getByRole('heading', { name: 'Edit X' })).toBeInTheDocument();
    expect(screen.getByLabelText('X App-only Bearer Token')).toHaveValue('');
    expect(
      screen.getByText('Leave blank to keep the existing token.'),
    ).toBeInTheDocument();
  });

  it('keeps the Vercel card read-only for non-admins', () => {
    state.isAdmin = false;

    render(<Integrations />);

    expect(
      screen.queryByRole('button', { name: 'Configure Vercel' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Vercel')).toBeInTheDocument();
  });

  it('submits Snowflake key pair credentials from the dialog', () => {
    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Snowflake' }),
    );
    fireEvent.change(screen.getByLabelText('Account identifier'), {
      target: { value: 'xy12345.us-east-1' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'roomote_user' },
    });
    fireEvent.change(screen.getByLabelText('Private Key (PEM)'), {
      target: {
        value: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      },
    });
    fireEvent.change(
      screen.getByLabelText('Private Key Passphrase (optional)'),
      {
        target: { value: 'pem-passphrase' },
      },
    );
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'ANALYST' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Snowflake' }));

    expect(mutations.saveSnowflakeConnection).toHaveBeenCalledWith(
      {
        authMethod: 'key_pair',
        account: 'xy12345.us-east-1',
        username: 'roomote_user',
        password: '',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        privateKeyPassphrase: 'pem-passphrase',
        role: 'ANALYST',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('submits Snowflake key pair credentials without warehouse or database fields', () => {
    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Configure Snowflake' }),
    );
    fireEvent.change(screen.getByLabelText('Account identifier'), {
      target: { value: 'xy12345.us-east-1' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'roomote_user' },
    });
    fireEvent.change(screen.getByLabelText('Private Key (PEM)'), {
      target: {
        value: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      },
    });
    fireEvent.change(screen.getByLabelText('Role'), {
      target: { value: 'ANALYST' },
    });
    expect(screen.queryByLabelText('Warehouse')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Database')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Snowflake' }));

    expect(mutations.saveSnowflakeConnection).toHaveBeenCalledWith(
      {
        authMethod: 'key_pair',
        account: 'xy12345.us-east-1',
        username: 'roomote_user',
        password: '',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        privateKeyPassphrase: '',
        role: 'ANALYST',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows Snowflake connected controls without status copy and supports editing', () => {
    state.deploymentEnablements = [{ mcpId: 'snowflake', enabled: true }];
    state.userConnections = [
      {
        mcpId: 'snowflake',
        authStatus: 'authenticated',
      },
    ];
    state.snowflakeConnection = {
      authStatus: 'authenticated',
      authMethod: 'key_pair',
      account: 'xy12345.us-east-1',
      username: 'roomote_user',
      role: 'ANALYST',
      warehouse: 'COMPUTE_WH',
      database: 'ROOMOTE',
    };

    render(<Integrations />);

    expect(
      screen.queryByText('Connected to xy12345.us-east-1 with role ANALYST.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Edit Snowflake connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect Snowflake' }),
    ).toBeInTheDocument();

    const snowflakeCard = screen
      .getByRole('heading', { name: 'Snowflake' })
      .closest('#integration-snowflake');
    expect(snowflakeCard).not.toBeNull();
    expect(
      within(snowflakeCard as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Disconnect Snowflake', 'Edit Snowflake connection']);

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Snowflake connection' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Edit Snowflake' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Account identifier')).toHaveValue(
      'xy12345.us-east-1',
    );
    expect(screen.getByLabelText('Private Key (PEM)')).toHaveValue('');
    expect(
      screen.getByLabelText('Private Key Passphrase (optional)'),
    ).toHaveValue('');
    expect(screen.getByLabelText('Role')).toHaveValue('ANALYST');
    expect(
      screen.getByText('Leave blank to keep the existing private key.'),
    ).toBeInTheDocument();
  });

  it('requires a new private key when editing a legacy PAT-backed Snowflake connection', () => {
    state.userConnections = [
      { mcpId: 'snowflake', authStatus: 'authenticated' },
    ];
    state.deploymentEnablements = [{ mcpId: 'snowflake', enabled: true }];
    state.snowflakeConnection = {
      authStatus: 'authenticated',
      authMethod: 'password',
      account: 'xy12345.us-east-1',
      username: 'roomote_user',
      role: 'ANALYST',
    };

    render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Snowflake connection' }),
    );

    expect(
      screen.queryByText('Leave blank to keep the existing private key.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByText('Private key is required')).toBeInTheDocument();
    expect(mutations.saveSnowflakeConnection).not.toHaveBeenCalled();
  });

  it('preserves unsaved tool toggles when the same upstream tool state is returned again', () => {
    state.deploymentEnablements = [{ mcpId: 'sentry', enabled: true }];
    state.userConnections = [
      { id: 'conn-sentry', mcpId: 'sentry', authStatus: 'authenticated' },
    ];
    state.mcpTools = {
      mcpId: 'sentry',
      tools: [
        {
          name: 'get_sentry_resource',
          description: 'Inspect a Sentry resource',
          enabled: true,
        },
        {
          name: 'search_events',
          description: 'Search events',
          enabled: false,
        },
      ],
    };

    const { rerender } = render(<Integrations />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Sentry tools' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Disable get_sentry_resource' }),
    );

    rerender(<Integrations />);

    expect(
      screen.getByRole('heading', { name: 'Manage Sentry tools' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enable get_sentry_resource' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enable search_events' }),
    ).toBeInTheDocument();
  });
});
