import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { CustomMcpServers } from './CustomMcpServers';

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

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CustomMcpServers />
    </QueryClientProvider>,
  );
}

describe('CustomMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.availability = { enabled: true };
    state.servers = [];
  });

  it('renders the empty state', async () => {
    renderComponent();

    expect(
      await screen.findByText('No custom MCP servers configured yet.'),
    ).toBeInTheDocument();
  });

  it('renders nothing when the operator kill switch is set', async () => {
    state.availability = { enabled: false };

    renderComponent();

    await waitFor(() => {
      expect(screen.queryByText('Custom MCP Servers')).not.toBeInTheDocument();
    });
  });

  it('lists servers with masked header badges and never shows values', async () => {
    state.servers = [buildServer()];

    renderComponent();

    expect(await screen.findByText('internal-tools')).toBeInTheDocument();
    expect(screen.getByText('https://mcp.example.com/mcp')).toBeInTheDocument();
    expect(screen.getByText(/1 header/)).toBeInTheDocument();
  });

  it('shows a Connect button for unauthenticated oauth servers', async () => {
    state.servers = [
      buildServer({
        authType: 'oauth',
        headerNames: [],
        authStatus: 'pending',
      }),
    ];

    renderComponent();

    expect(await screen.findByText('Connect')).toBeInTheDocument();
    expect(screen.getByText(/not connected/)).toBeInTheDocument();
  });

  it('shows a reconnect badge when refresh definitively failed', async () => {
    state.servers = [
      buildServer({
        authType: 'oauth',
        headerNames: [],
        authStatus: 'error',
      }),
    ];

    renderComponent();

    expect(await screen.findByText(/reconnect needed/)).toBeInTheDocument();
  });

  it('opens the add dialog', async () => {
    renderComponent();

    fireEvent.click(await screen.findByRole('button', { name: /add/i }));

    expect(
      await screen.findByText('Add custom MCP server'),
    ).toBeInTheDocument();
    expect(screen.getByText('Remote (HTTP)')).toBeInTheDocument();
    expect(screen.getByText('Local (stdio)')).toBeInTheDocument();
  });
});
