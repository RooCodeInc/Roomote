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
};

const { state, createMock, deleteMock, setEnabledMock } = vi.hoisted(() => ({
  state: {
    availability: { enabled: true },
    servers: [] as ListedServer[],
    tools: [] as {
      name: string;
      description: string | null;
      enabled: boolean;
    }[],
  },
  createMock: vi.fn(async () => ({ id: 'new-server' })),
  deleteMock: vi.fn(async () => ({ deleted: true })),
  setEnabledMock: vi.fn(async () => ({ enabled: false })),
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
          queryFn: async () => state.servers,
        }),
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
            {item.manageToolsAction ? (
              <button
                type="button"
                onClick={item.manageToolsAction.onAction}
                aria-label={item.manageToolsAction.ariaLabel}
              >
                Manage tools
              </button>
            ) : null}
            {item.removeAction ? (
              <button
                type="button"
                onClick={item.removeAction.onAction}
                aria-label={item.removeAction.ariaLabel}
              >
                Remove
              </button>
            ) : null}
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
});
