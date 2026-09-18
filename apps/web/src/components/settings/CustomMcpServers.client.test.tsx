import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type ListedServer = {
  id: string;
  name: string;
  transport: 'remote' | 'stdio';
  url: string | null;
  authType: 'none' | 'static_headers' | 'oauth';
  headerNames: string[];
  stdioCommand: string | null;
  stdioArgs: string[];
  stdioEnvNames: string[];
  disabledTools: string[];
  hasManualClient: boolean;
  oauthResourceIndicatorDisabled: boolean;
  authStatus: 'pending' | 'authenticated' | 'error' | null;
  enabled: boolean;
  visibility: 'owner' | 'deployment';
  canManage: boolean;
};

const {
  state,
  createMock,
  openKeyDialogMock,
  deleteMock,
  setEnabledMock,
  setVisibilityMock,
  listInputs,
  toastSuccessMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  state: {
    availability: { enabled: true },
    isAdmin: true,
    servers: [] as ListedServer[],
    listFails: false,
    tools: [] as {
      name: string;
      description: string | null;
      enabled: boolean;
    }[],
  },
  openKeyDialogMock: vi.fn(),
  createMock: vi.fn(async (_input: Record<string, unknown>) => ({
    id: 'new-server',
  })),
  deleteMock: vi.fn(async () => ({ deleted: true })),
  setEnabledMock: vi.fn(async () => ({ enabled: false })),
  setVisibilityMock: vi.fn(async () => ({ visibility: 'owner' })),
  listInputs: [] as unknown[],
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    customMcpServers: {
      availability: {
        queryKey: () => ['customMcpServers', 'availability'],
        queryOptions: () => ({
          queryKey: ['customMcpServers', 'availability'],
          queryFn: async () => state.availability,
        }),
      },
      list: {
        queryKey: () => ['customMcpServers', 'list'],
        queryOptions: (input?: unknown) => {
          listInputs.push(input);
          return {
            queryKey: ['customMcpServers', 'list', input ?? null],
            queryFn: async () => {
              if (state.listFails) throw new Error('offline');
              return state.servers;
            },
          };
        },
      },
      listTools: {
        queryKey: () => ['customMcpServers', 'listTools'],
        queryOptions: (
          input: { id: string },
          options: Record<string, unknown> = {},
        ) => ({
          queryKey: ['customMcpServers', 'listTools', input.id],
          queryFn: async () => ({ tools: state.tools }),
          ...options,
        }),
      },
      create: {
        mutationOptions: (options = {}) => ({
          mutationFn: createMock,
          ...options,
        }),
      },
      update: {
        mutationOptions: (options = {}) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      delete: {
        mutationOptions: (options = {}) => ({
          mutationFn: deleteMock,
          ...options,
        }),
      },
      setEnabled: {
        mutationOptions: (options = {}) => ({
          mutationFn: setEnabledMock,
          ...options,
        }),
      },
      setVisibility: {
        mutationOptions: (options = {}) => ({
          mutationFn: setVisibilityMock,
          ...options,
        }),
      },
      setDisabledTools: {
        mutationOptions: (options = {}) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      connect: {
        mutationOptions: (options = {}) => ({
          mutationFn: vi.fn(async () => '/api/mcp-oauth/initiate/conn-1'),
          ...options,
        }),
      },
      disconnect: {
        mutationOptions: (options = {}) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
    },
  }),
}));

import { IntegrationListRow, type IntegrationItem } from './integration-card';
import { useCustomMcpServers } from './CustomMcpServers';
import { PersonalIntegrations } from './PersonalIntegrations';

function buildServer(overrides: Partial<ListedServer> = {}): ListedServer {
  return {
    id: '4c72c9dd-3f5e-4d3e-9f7a-2c1b8a6e5d40',
    name: 'internal-tools',
    transport: 'remote',
    url: 'https://mcp.example.com/mcp',
    authType: 'static_headers',
    headerNames: ['x-api-key'],
    stdioCommand: null,
    stdioArgs: [],
    stdioEnvNames: [],
    disabledTools: [],
    hasManualClient: false,
    oauthResourceIndicatorDisabled: false,
    authStatus: null,
    enabled: true,
    visibility: 'deployment',
    canManage: true,
    ...overrides,
  };
}

/**
 * Renders what the hook produces: custom servers become plain integration
 * items, so the assertions below mirror what the Integrations grids show.
 */
function Harness() {
  const { isEnabled, items, openAddDialog, dialogs } = useCustomMcpServers();

  return (
    <div>
      <span data-testid="enabled">{String(isEnabled)}</span>
      <button type="button" data-testid="open-add" onClick={openAddDialog}>
        Add
      </button>
      <ul>
        {items.map((item: IntegrationItem) => (
          <li key={item.id} data-testid="item">
            <span data-testid="name">{item.name}</span>
            <span data-testid="description">{item.description}</span>
            <span data-testid="badge">{item.badge}</span>
            <span data-testid="status">{item.status}</span>
            <span data-testid="secondary">{item.secondaryAction?.label}</span>
            <span data-testid="utility">{item.utilityAction?.label}</span>
            <span data-testid="configured">{String(item.configured)}</span>
            <span data-testid="item-enabled">{String(item.enabled)}</span>
            <span data-testid="item-connected">{String(item.connected)}</span>
            <IntegrationListRow item={item} />
          </li>
        ))}
      </ul>
      {dialogs}
    </div>
  );
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe('useCustomMcpServers', () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.availability = { enabled: true };
    state.servers = [];
  });

  it('produces no items when there are no servers', async () => {
    renderHarness();

    await waitFor(() => {
      expect(screen.getByTestId('enabled')).toHaveTextContent('true');
    });
    expect(screen.queryAllByTestId('item')).toHaveLength(0);
  });

  it('reports disabled when the operator kill switch is set', async () => {
    state.availability = { enabled: false };
    state.servers = [buildServer()];

    renderHarness();

    await waitFor(() => {
      expect(screen.getByTestId('enabled')).toHaveTextContent('false');
    });
    expect(screen.queryAllByTestId('item')).toHaveLength(0);
  });

  it('renders a remote server without a type badge or leaking secrets', async () => {
    state.servers = [buildServer()];

    renderHarness();

    expect(await screen.findByTestId('name')).toHaveTextContent(
      'internal-tools',
    );
    expect(screen.getByTestId('badge')).toBeEmptyDOMElement();
    expect(screen.getByTestId('description')).toHaveTextContent(
      'https://mcp.example.com/mcp',
    );
    // Disabled custom servers group with "Configured", never "Available".
    expect(screen.getByTestId('configured')).toHaveTextContent('true');
    expect(screen.getByTestId('utility')).toHaveTextContent('Manage tools');
    expect(screen.getByTestId('secondary')).toHaveTextContent('Edit');
  });

  it('uses a dialog to confirm removing a custom server', async () => {
    const server = buildServer();
    state.servers = [server];

    renderHarness();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove internal-tools' }),
    );

    expect(
      screen.getByRole('heading', { name: 'Remove internal-tools?' }),
    ).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith(
        { id: server.id },
        expect.anything(),
      ),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('internal-tools removed.');
  });

  it('names the tools dialog for the selected integration', async () => {
    state.servers = [buildServer()];

    renderHarness();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Manage internal-tools tools',
      }),
    );

    expect(
      screen.getByRole('heading', {
        name: 'Manage tools for internal-tools',
      }),
    ).toBeInTheDocument();
  });

  it('offers Connect and a status for unauthenticated oauth servers', async () => {
    state.servers = [
      buildServer({
        authType: 'oauth',
        headerNames: [],
        authStatus: 'pending',
      }),
    ];

    renderHarness();

    expect(await screen.findByTestId('secondary')).toHaveTextContent('Connect');
    expect(screen.getByTestId('status')).toHaveTextContent('Not connected yet');
    expect(screen.getByTestId('item-connected')).toHaveTextContent('false');
  });

  it('surfaces a reconnect prompt when a refresh was rejected', async () => {
    state.servers = [
      buildServer({ authType: 'oauth', headerNames: [], authStatus: 'error' }),
    ];

    renderHarness();

    expect(await screen.findByTestId('status')).toHaveTextContent(
      'needs to be reconnected',
    );
  });

  it('describes stdio servers by their command and omits tool management', async () => {
    state.servers = [
      buildServer({
        transport: 'stdio',
        url: null,
        authType: 'none',
        headerNames: [],
        stdioCommand: 'npx',
        stdioArgs: ['-y', '@example/server'],
        stdioEnvNames: ['EXAMPLE_TOKEN'],
      }),
    ];

    renderHarness();

    expect(await screen.findByTestId('description')).toHaveTextContent(
      'npx -y @example/server',
    );
    // Local servers bypass the proxy, so there is nothing to enforce tool
    // filtering and no Manage tools affordance.
    expect(screen.getByTestId('utility')).toBeEmptyDOMElement();
  });

  it('marks disabled servers so they leave the Connected group', async () => {
    state.servers = [buildServer({ enabled: false })];

    renderHarness();

    expect(await screen.findByTestId('item-enabled')).toHaveTextContent(
      'false',
    );
  });

  it('lets admins manage and re-enable saved disabled servers from the add dialog', async () => {
    const server = buildServer({ enabled: false });
    state.servers = [server];

    renderHarness();
    fireEvent.click(await screen.findByTestId('open-add'));

    expect(screen.getByText('Disabled custom MCP servers')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Re-enable a saved server without re-entering its credentials, or edit its configuration first.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(setEnabledMock).toHaveBeenCalledWith(
        { id: server.id, enabled: true },
        expect.anything(),
      ),
    );
  });

  it('opens disabled server configuration from the add dialog', async () => {
    state.servers = [buildServer({ enabled: false })];

    renderHarness();
    fireEvent.click(await screen.findByTestId('open-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(
      screen.getByRole('heading', { name: 'Edit custom MCP server' }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toBeDisabled();
  });

  it('prefills the add dialog from a pasted JSON snippet', async () => {
    renderHarness();

    fireEvent.click(await screen.findByTestId('open-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Import from JSON' }));
    fireEvent.change(screen.getByLabelText('Paste a JSON config'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            'example-tools': {
              command: 'npx',
              args: ['-y', '@example/mcp-server'],
              env: { EXAMPLE_TOKEN: 'tok' },
            },
          },
        }),
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Fill form from JSON' }),
    );

    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue(
      'example-tools',
    );
    expect(screen.getByPlaceholderText('e.g. npx')).toHaveValue('npx');
    expect(screen.getByPlaceholderText(/@example\/mcp-server/)).toHaveValue(
      '-y\n@example/mcp-server',
    );
    expect(screen.getByPlaceholderText('e.g. EXAMPLE_TOKEN')).toHaveValue(
      'EXAMPLE_TOKEN',
    );
  });

  it('converts a pasted mcp-remote launcher into a remote server', async () => {
    renderHarness();

    fireEvent.click(await screen.findByTestId('open-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Import from JSON' }));
    fireEvent.change(screen.getByLabelText('Paste a JSON config'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            notion: {
              command: 'npx',
              args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
            },
          },
        }),
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Fill form from JSON' }),
    );

    expect(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
    ).toHaveValue('https://mcp.notion.com/mcp');
    expect(
      screen.getByText(/Converted an mcp-remote launcher/),
    ).toBeInTheDocument();
  });

  it('reports a parse error without touching the form', async () => {
    renderHarness();

    fireEvent.click(await screen.findByTestId('open-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Import from JSON' }));
    fireEvent.change(screen.getByLabelText('Paste a JSON config'), {
      target: { value: 'not json' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Fill form from JSON' }),
    );

    expect(
      screen.getByText('The pasted text is not valid JSON.'),
    ).toBeInTheDocument();
  });

  describe('mirroring integration keys', () => {
    beforeEach(() => {
      state.isAdmin = true;
      state.servers = [];
      listInputs.length = 0;
      createMock.mockClear();
      setVisibilityMock.mockClear();
    });

    it('shows a shared server someone else added read-only', async () => {
      state.isAdmin = false;
      state.servers = [buildServer({ canManage: false })];
      renderHarness();

      expect(await screen.findByTestId('status')).toHaveTextContent(
        'Added by another member.',
      );
      expect(screen.getByTestId('secondary')).toBeEmptyDOMElement();
      expect(
        screen.queryByRole('button', { name: /Remove internal-tools/ }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: /Configure internal-tools/ }),
      ).toBeNull();
    });

    it('says a shared server is waiting on its owner when it is not connected', async () => {
      state.servers = [
        buildServer({
          canManage: false,
          authType: 'oauth',
          authStatus: 'pending',
        }),
      ];
      renderHarness();

      expect(await screen.findByTestId('status')).toHaveTextContent(
        'Waiting on the member who added it to connect it.',
      );
    });

    it('lets a member choose who can use a new server, shared by default', async () => {
      state.isAdmin = false;
      renderHarness();

      fireEvent.click(await screen.findByTestId('open-add'));
      // Local (stdio) servers stay with administrators.
      expect(screen.queryByLabelText('Local (stdio)')).toBeNull();
      expect(
        screen.getByLabelText('Everyone in this deployment'),
      ).toBeChecked();

      fireEvent.change(screen.getByPlaceholderText('e.g. internal-tools'), {
        target: { value: 'intercom' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('https://mcp.example.com/mcp'),
        { target: { value: 'https://mcp.example.com/mcp' } },
      );
      fireEvent.click(screen.getByLabelText('Only me'));
      fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
      expect(createMock.mock.calls[0]?.[0]).toMatchObject({
        transport: 'remote',
        name: 'intercom',
        visibility: 'owner',
      });
    });

    it('moves a server to Personal settings when its owner makes it private', async () => {
      state.servers = [buildServer({ authType: 'none', headerNames: [] })];
      renderHarness();

      fireEvent.click(
        await screen.findByRole('button', { name: 'Configure internal-tools' }),
      );
      fireEvent.click(await screen.findByLabelText('Only me'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(setVisibilityMock).toHaveBeenCalledWith(
          {
            id: '4c72c9dd-3f5e-4d3e-9f7a-2c1b8a6e5d40',
            visibility: 'owner',
          },
          expect.anything(),
        ),
      );
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'internal-tools moved to Personal settings.',
      );
    });
  });
});

vi.mock('./YourIntegrations', () => ({
  useYourIntegrations: () => ({
    items: [],
    isLoading: false,
    error: null,
    openAddDialog: openKeyDialogMock,
    dialogs: null,
  }),
}));

describe('personal MCP servers in Personal settings', () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  function renderSection() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <PersonalIntegrations />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    state.isAdmin = false;
    state.availability = { enabled: true };
    state.servers = [];
    state.listFails = false;
    listInputs.length = 0;
    createMock.mockClear();
    openKeyDialogMock.mockClear();
  });

  /** Opens one of the two choices behind "Add personal integration". */
  async function chooseAddOption(name: 'Custom MCP' | 'API-key based') {
    fireEvent.keyDown(
      await screen.findByRole('button', { name: 'Add personal integration' }),
      { key: 'Enter' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name }));
  }

  it("asks only for the viewer's private servers and shows an empty state", async () => {
    renderSection();

    expect(
      await screen.findByText('No personal integrations yet.'),
    ).toBeInTheDocument();
    expect(listInputs).toContainEqual({ scope: 'owner' });
    expect(listInputs).not.toContainEqual(undefined);
  });

  it('adds a private remote server without offering a transport or visibility choice', async () => {
    renderSection();

    await chooseAddOption('Custom MCP');
    expect(screen.queryByLabelText('Local (stdio)')).toBeNull();
    expect(screen.queryByLabelText('Everyone in this deployment')).toBeNull();
    expect(
      screen.getByText(/available only to your own Sessions and tasks/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. internal-tools'), {
      target: { value: 'intercom' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
      { target: { value: 'https://mcp.example.com/mcp' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      name: 'intercom',
      visibility: 'owner',
    });
  });

  it('keeps a JSON-imported server private instead of sharing it', async () => {
    renderSection();

    await chooseAddOption('Custom MCP');
    fireEvent.click(screen.getByRole('button', { name: 'Import from JSON' }));
    fireEvent.change(screen.getByLabelText('Paste a JSON config'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            'example-tools': { url: 'https://mcp.example.com/mcp' },
          },
        }),
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Fill form from JSON' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      name: 'example-tools',
      visibility: 'owner',
    });
  });

  it('reports a failed load instead of claiming the member has none', async () => {
    state.listFails = true;
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'MCP servers are unavailable.',
    );
    expect(screen.queryByText('No personal integrations yet.')).toBeNull();
  });

  it('offers only the API-key route when the operator disabled custom MCP servers', async () => {
    state.availability = { enabled: false };
    state.servers = [buildServer({ visibility: 'owner' })];
    renderSection();

    // The picker collapses to a plain button once availability resolves.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add personal integration' }),
      ).not.toHaveAttribute('aria-haspopup'),
    );
    expect(screen.queryByText('internal-tools')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Add personal integration' }),
    );
    expect(openKeyDialogMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('routes the API-key choice to the integration-key dialog', async () => {
    renderSection();

    await chooseAddOption('API-key based');

    expect(openKeyDialogMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('lists a private server with its manage actions', async () => {
    state.servers = [buildServer({ visibility: 'owner' })];
    renderSection();

    expect(await screen.findByText('internal-tools')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Remove internal-tools/ }),
    ).toBeInTheDocument();
  });
});
