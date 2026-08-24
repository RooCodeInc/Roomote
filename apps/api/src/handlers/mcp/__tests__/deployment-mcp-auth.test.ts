import type {
  AuthTokenContext,
  AutomationTokenContext,
  McpAccessTokenContext,
  RunTokenContext,
} from '@roomote/types';

const { mockFindTaskRun, mockGetAutomationRun, mockEq } = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockGetAutomationRun: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
    },
  },
  taskRuns: { id: 'taskRuns.id' },
  eq: mockEq,
  getActiveAutomationRunForPrincipal: mockGetAutomationRun,
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
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockGetAutomationRun.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
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
    expect(mockFindTaskRun).not.toHaveBeenCalled();
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
    expect(mockFindTaskRun).toHaveBeenCalledWith({
      columns: { id: true },
      where: { column: 'taskRuns.id', value: 42 },
    });
  });

  it('keeps deployment-principal run tokens independent of the acting user', async () => {
    mockFindTaskRun.mockResolvedValue({ id: 42, actingUserId: 'user-2' });
    const runToken = createRunToken({
      userId: null,
      principal: 'deployment',
    });

    await expect(
      resolveDeploymentMcpAuth(runToken, providerName),
    ).resolves.toEqual({ userId: null, tokenType: 'run', runId: 42 });
  });

  it('rejects run tokens whose target task run no longer exists', async () => {
    mockFindTaskRun.mockResolvedValue(undefined);

    await expect(
      resolveDeploymentMcpAuth(createRunToken(), providerName),
    ).rejects.toMatchObject({
      httpStatus: 404,
      message: 'Task run not found for this MCP token',
    });
  });

  it('accepts an active automation principal', async () => {
    const automationToken: AutomationTokenContext = {
      automationRunId: '11111111-1111-4111-8111-111111111111',
      leaseOwner: 'worker-1',
      policyVersion: 1,
      principal: 'deployment',
      tokenType: 'automation',
      userId: null,
      version: 1,
    };

    await expect(
      resolveDeploymentMcpAuth(automationToken, providerName),
    ).resolves.toEqual({
      userId: null,
      tokenType: 'automation',
      automationRunId: automationToken.automationRunId,
      automationLeaseOwner: automationToken.leaseOwner,
      automationPolicyVersion: automationToken.policyVersion,
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
      message: `${providerName} MCP requires a user, task run, or authorized automation token for server-side credential access`,
    });
  });
});
