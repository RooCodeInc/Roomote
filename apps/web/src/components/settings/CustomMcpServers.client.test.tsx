import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
};

const {
  state,
  createMock,
  updateMock,
  deleteMock,
  setEnabledMock,
  connectMock,
  listToolsMock,
} = vi.hoisted(() => ({
  state: {
    availability: { enabled: true },
    servers: [] as ListedServer[],
    serversPromise: null as Promise<ListedServer[]> | null,
    toolsError: false,
    tools: [] as {
      name: string;
      description: string | null;
      enabled: boolean;
    }[],
  },
  createMock: vi.fn(async () => ({ id: 'new-server' })),
  updateMock: vi.fn(async () => ({ updated: true })),
  deleteMock: vi.fn(async () => ({ deleted: true })),
  setEnabledMock: vi.fn(async () => ({ enabled: false })),
  connectMock: vi.fn(async () => '/api/mcp-oauth/initiate/conn-1'),
  listToolsMock: vi.fn(),
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
        queryOptions: () => ({
          queryKey: ['customMcpServers', 'list'],
          queryFn: async () => state.serversPromise ?? state.servers,
        }),
      },
      listTools: {
        queryKey: () => ['customMcpServers', 'listTools'],
        queryOptions: (
          input: { id: string },
          options: Record<string, unknown> = {},
        ) => ({
          queryKey: ['customMcpServers', 'listTools', input.id],
          queryFn: async () => {
            listToolsMock();
            if (state.toolsError) throw new Error('Could not list tools');
            return { tools: state.tools };
          },
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
          mutationFn: updateMock,
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
      setDisabledTools: {
        mutationOptions: (options = {}) => ({
          mutationFn: vi.fn(),
          ...options,
        }),
      },
      connect: {
        mutationOptions: (options = {}) => ({
          mutationFn: connectMock,
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

import type { IntegrationItem } from './integration-card';
import { useCustomMcpServers } from './CustomMcpServers';

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
    ...overrides,
  };
}

/**
 * Renders what the hook produces: custom servers become plain integration
 * items, so the assertions below mirror what the Integrations grids show.
 */
function Harness({
  isAdmin = true,
  connectionName = null,
  configureId = null,
}: {
  isAdmin?: boolean;
  connectionName?: string | null;
  configureId?: string | null;
}) {
  const { isEnabled, items, openAddDialog, dialogs } = useCustomMcpServers({
    isAdmin,
    connectionName,
    configureId,
  });

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
            {item.utilityAction && (
              <button onClick={item.utilityAction.onAction}>
                Manage tools
              </button>
            )}
          </li>
        ))}
      </ul>
      {dialogs}
    </div>
  );
}

function renderHarness(
  props: {
    isAdmin?: boolean;
    connectionName?: string | null;
    configureId?: string | null;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <Harness {...props} />
      </QueryClientProvider>,
    ),
    queryClient,
  };
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
    state.serversPromise = null;
    state.tools = [];
    state.toolsError = false;
    window.history.replaceState(null, '', '/settings/integrations');
  });

  it('opens the saved disabled row, focuses authentication and saves without activation', async () => {
    const server = buildServer({ enabled: false });
    state.servers = [server];
    window.history.replaceState(
      null,
      '',
      `/settings/integrations?configure=custom%3A${server.id}&url=https://evil.example&token=secret&name=other&authType=oauth`,
    );
    renderHarness({ configureId: `custom:${server.id}` });
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Authorize integration',
    );
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue(
      server.name,
    );
    expect(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
    ).toHaveValue(server.url);
    expect(screen.getByPlaceholderText('e.g. x-api-key')).toHaveValue(
      'x-api-key',
    );
    expect(
      screen.getByPlaceholderText('Leave blank to keep the existing value'),
    ).toHaveValue('');
    expect(screen.getByRole('group', { name: 'Authentication' })).toHaveFocus();
    expect(window.location.search).toBe('');
    expect(document.body.textContent).not.toContain('secret');
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(listToolsMock).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByPlaceholderText('Leave blank to keep the existing value'),
      { target: { value: 'human-entered-key' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        {
          id: server.id,
          server: {
            transport: 'remote',
            name: server.name,
            url: server.url,
            authType: 'static_headers',
            headers: { 'x-api-key': 'human-entered-key' },
          },
        },
        expect.anything(),
      ),
    );
    expect(setEnabledMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('item-enabled')).toHaveTextContent('false');
  });

  it('clears link parameters before the saved list loads and then opens the matching row', async () => {
    const server = buildServer({ enabled: false });
    let resolveServers!: (servers: ListedServer[]) => void;
    state.serversPromise = new Promise((resolve) => {
      resolveServers = resolve;
    });
    window.history.replaceState(
      null,
      '',
      `/settings/integrations?configure=custom%3A${server.id}&token=secret`,
    );
    renderHarness({ configureId: `custom:${server.id}` });
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      resolveServers([server]);
    });
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Authorize integration',
    );
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue(
      server.name,
    );
  });

  it('allows secure header entry for a prepared row without existing headers', async () => {
    const server = buildServer({ enabled: false, headerNames: [] });
    state.servers = [server];
    renderHarness({ configureId: `custom:${server.id}` });
    await screen.findByRole('dialog');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }),
    );
    expect(screen.getByPlaceholderText('e.g. x-api-key')).toHaveValue('');
    expect(
      screen.getByPlaceholderText('Leave blank to keep the existing value'),
    ).toHaveValue('');
  });

  it('does not authorize OAuth when opening or saving a saved OAuth row', async () => {
    const server = buildServer({
      enabled: false,
      authType: 'oauth',
      headerNames: [],
      oauthResourceIndicatorDisabled: true,
    });
    state.servers = [server];
    renderHarness({ configureId: `custom:${server.id}` });
    await screen.findByRole('dialog');
    expect(screen.getByRole('radio', { name: 'OAuth' })).toBeChecked();
    expect(screen.getByRole('switch')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(connectMock).not.toHaveBeenCalled();
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('consumes a saved-row link once and does not reopen after dismissal or refetch', async () => {
    const server = buildServer();
    state.servers = [server];
    const { queryClient } = renderHarness({
      configureId: `custom:${server.id}`,
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    state.servers = [{ ...server }];
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['customMcpServers', 'list'],
      });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-add'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Add custom MCP server',
    );
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue('');
  });

  it.each([
    { isAdmin: false, enabled: true, exists: true },
    { isAdmin: true, enabled: false, exists: true },
    { isAdmin: true, enabled: true, exists: false },
  ])(
    'does not open saved setup without access or a matching row: %j',
    async ({ isAdmin, enabled, exists }) => {
      const server = buildServer();
      state.servers = exists ? [server] : [];
      state.availability = { enabled };
      window.history.replaceState(
        null,
        '',
        `/settings/integrations?configure=custom%3A${server.id}&token=secret`,
      );
      renderHarness({ isAdmin, configureId: `custom:${server.id}` });
      await waitFor(() => expect(window.location.search).toBe(''));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(createMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(connectMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'custom:unknown',
    'native:pylon',
    'custom:4c72c9dd-3f5e-4d3e-9f7a-2c1b8a6e5d40?token=secret',
    'https://user:secret@evil.example',
  ])(
    'ignores invalid configure ID %s without falling back to creation',
    async (configureId) => {
      state.servers = [buildServer()];
      renderHarness({ configureId, connectionName: 'should-not-create' });
      await screen.findByTestId('name');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(createMock).not.toHaveBeenCalled();
    },
  );

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

  it('renders a remote server as a Custom-badged item without leaking secrets', async () => {
    state.servers = [buildServer()];

    renderHarness();

    expect(await screen.findByTestId('name')).toHaveTextContent(
      'internal-tools',
    );
    expect(screen.getByTestId('badge')).toHaveTextContent('Custom');
    expect(screen.getByTestId('description')).toHaveTextContent(
      'https://mcp.example.com/mcp',
    );
    // Disabled custom servers group with "Configured", never "Available".
    expect(screen.getByTestId('configured')).toHaveTextContent('true');
    expect(screen.getByTestId('utility')).toHaveTextContent('Manage tools');
    expect(screen.getByTestId('secondary')).toHaveTextContent('Edit');
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
    expect(screen.getByTestId('status')).toHaveTextContent(
      'Saved. Authorization pending.',
    );
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

  it('opens a remote-only connection form once with a sanitized name and no automatic mutation', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/integrations?connect=custom&name=Acme%20Tools&url=https://evil.example&token=secret&transport=stdio',
    );
    renderHarness({ connectionName: 'Acme Tools' });
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Connect integration',
    );
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue(
      'acme-tools',
    );
    expect(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
    ).toHaveValue('');
    expect(screen.queryByText('Import from JSON')).not.toBeInTheDocument();
    expect(screen.queryByText('Local (stdio)')).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(createMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(listToolsMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-add'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Add custom MCP server',
    );
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue('');
    expect(screen.getByText('Import from JSON')).toBeInTheDocument();
  });

  it.each([
    ['Example & Co', 'example-co'],
    ["Acme's Tools (EU)+", 'acme-s-tools-eu'],
    ['Caf\u00e9 Tools', 'caf-tools'],
  ])(
    'prefills valid preparation provider %s',
    async (connectionName, expected) => {
      renderHarness({ connectionName });
      await screen.findByRole('dialog');
      expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue(
        expected,
      );
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://user:secret@evil.example',
    '<script>alert(1)</script>',
    'a'.repeat(101),
    'a'.repeat(81),
    'api_key=secret',
    'Acme\nTools',
  ])('does not prefill unsafe name %s', async (connectionName) => {
    renderHarness({ connectionName });
    await screen.findByRole('dialog');
    expect(screen.getByPlaceholderText('e.g. internal-tools')).toHaveValue('');
    expect(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
    ).toHaveValue('');
  });

  it.each([
    { isAdmin: false, enabled: true },
    { isAdmin: true, enabled: false },
  ])(
    'does not open for unauthorized or disabled entry: %j',
    async ({ isAdmin, enabled }) => {
      state.availability = { enabled };
      renderHarness({ isAdmin, connectionName: 'acme' });
      await waitFor(() =>
        expect(screen.getByTestId('enabled')).toHaveTextContent(
          String(enabled),
        ),
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it('requires the human URL and saves through the existing remote mutation', async () => {
    renderHarness({ connectionName: 'Acme' });
    await screen.findByRole('dialog');
    fireEvent.change(
      screen.getByPlaceholderText('https://mcp.example.com/mcp'),
      { target: { value: 'https://acme.example/mcp' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save integration' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        {
          name: 'acme',
          transport: 'remote',
          url: 'https://acme.example/mcp',
          authType: 'none',
        },
        expect.anything(),
      ),
    );
  });

  it('does not label a saved remote integration connected or verified', async () => {
    state.servers = [buildServer()];
    renderHarness();
    expect(await screen.findByTestId('item-connected')).toHaveTextContent(
      'false',
    );
    expect(screen.getByTestId('status')).toHaveTextContent(
      'Saved. Use Manage tools to verify',
    );
  });

  it('only verifies tools after an explicit successful tool-list check', async () => {
    state.servers = [buildServer()];
    state.tools = [{ name: 'search', description: null, enabled: true }];
    renderHarness();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Manage tools' }),
    );
    expect(
      await screen.findByText(
        'Tools verified: the integration returned its tool list.',
      ),
    ).toBeInTheDocument();
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it('does not claim verification for an empty list', async () => {
    state.servers = [buildServer()];
    renderHarness();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Manage tools' }),
    );
    expect(
      await screen.findByText('The integration returned no tools.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Tools verified:/)).not.toBeInTheDocument();
  });

  it('disables tool-policy saving after a failed check', async () => {
    state.servers = [buildServer()];
    state.toolsError = true;
    renderHarness();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Manage tools' }),
    );
    expect(await screen.findByText('Could not list tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText(/Tools verified:/)).not.toBeInTheDocument();
  });
});
