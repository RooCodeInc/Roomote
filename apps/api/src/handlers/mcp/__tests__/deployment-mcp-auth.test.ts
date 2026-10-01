import {
  RunStatus,
  type AuthTokenContext,
  type McpAccessTokenContext,
  type RunTokenContext,
} from '@roomote/types';

const { mockEq, mockFindTaskRunByRunTokenClaims } = vi.hoisted(() => ({
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockFindTaskRunByRunTokenClaims: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: vi.fn() },
    },
  },
  taskRuns: { id: 'taskRuns.id' },
  eq: mockEq,
}));

vi.mock('@roomote/sdk/server', () => ({
  findTaskRunByRunTokenClaims: mockFindTaskRunByRunTokenClaims,
}));

import { resolveDeploymentMcpAuth } from '../deployment-mcp-auth';

const providers = [
  'Asana',
  'Grafana',
  'Granola',
  'Notion',
  'Snowflake',
  'Vercel',
];

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
    ...overrides,
  };
}

describe.each(providers)('%s deployment-scoped MCP auth', (providerName) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRunByRunTokenClaims.mockResolvedValue({ id: 42 });
  });

  it('rejects missing authentication', async () => {
    await expect(
      resolveDeploymentMcpAuth(undefined, providerName),
    ).rejects.toMatchObject({
      httpStatus: 401,
      message: 'Unauthorized: missing or invalid bearer token',
    });
  });

  it('accepts user auth tokens without validating a task run', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    await expect(
      resolveDeploymentMcpAuth(authToken, providerName),
    ).resolves.toEqual({ userId: 'user-1', tokenType: 'auth' });
  });

  it('accepts run tokens when the target task run exists', async () => {
    const runToken = createRunToken();

    await expect(
      resolveDeploymentMcpAuth(runToken, providerName),
    ).resolves.toEqual({
      userId: 'user-1',
      tokenType: 'run',
      runId: 42,
    });
    expect(mockFindTaskRunByRunTokenClaims).toHaveBeenCalledWith(runToken);
  });

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled])(
    'rejects terminal run status %s',
    async () => {
      mockFindTaskRunByRunTokenClaims.mockResolvedValue(null);

      await expect(
        resolveDeploymentMcpAuth(createRunToken(), providerName),
      ).rejects.toMatchObject({
        httpStatus: 404,
        message: 'Task run not found for this MCP token',
      });
    },
  );

  it('keeps deployment-principal run tokens independent of the acting user', async () => {
    const runToken = createRunToken({
      userId: null,
      principal: 'deployment',
    });

    await expect(
      resolveDeploymentMcpAuth(runToken, providerName),
    ).resolves.toEqual({ userId: null, tokenType: 'run', runId: 42 });
  });

  it('rejects run tokens whose target task run no longer exists', async () => {
    mockFindTaskRunByRunTokenClaims.mockResolvedValue(undefined);

    await expect(
      resolveDeploymentMcpAuth(createRunToken(), providerName),
    ).rejects.toMatchObject({
      httpStatus: 404,
      message: 'Task run not found for this MCP token',
    });
  });

  it('rejects MCP access tokens with the provider-specific public error', async () => {
    const mcpToken: McpAccessTokenContext = {
      userId: 'user-1',
      tokenType: 'mcp',
      version: 1,
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:access'],
    };

    await expect(
      resolveDeploymentMcpAuth(mcpToken, providerName),
    ).rejects.toMatchObject({
      httpStatus: 403,
      message: `${providerName} MCP requires a user auth token or task run token for server-side credential access`,
    });
  });
});
