import { useMcpConnectionTools } from './useMcpConnectionTools';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  queryOptions: vi.fn((input, options) => ({ input, options })),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQuery,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    mcpConnections: {
      listTools: {
        queryOptions: mocks.queryOptions,
      },
    },
  }),
}));

describe('useMcpConnectionTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not retry failed tool catalog queries', () => {
    useMcpConnectionTools('notion');

    expect(mocks.queryOptions).toHaveBeenCalledWith(
      { mcpId: 'notion' },
      { enabled: true, retry: false },
    );
    expect(mocks.useQuery).toHaveBeenCalledWith({
      input: { mcpId: 'notion' },
      options: { enabled: true, retry: false },
    });
  });

  it('keeps the query disabled until an MCP id is selected', () => {
    useMcpConnectionTools(null);

    expect(mocks.queryOptions).toHaveBeenCalledWith(
      { mcpId: '' },
      { enabled: false, retry: false },
    );
  });
});
