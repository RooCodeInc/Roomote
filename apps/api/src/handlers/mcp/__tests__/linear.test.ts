import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockResolveApprovalBlocks } = vi.hoisted(() => ({
  mockResolveApprovalBlocks: vi.fn(async () => ({
    blocks: new Map<string, string>(),
    shadowDefaultTools: false,
  })),
}));

vi.mock('../tool-approval-enforcement', () => ({
  describeProxyToolApprovalBlock: () => 'blocked by policy',
  resolveProxyToolApprovalBlocks: mockResolveApprovalBlocks,
  resolveProxyToolApprovalBlock: (
    approvals: { blocks: Map<string, string>; defaultBlock?: string },
    toolName: string,
  ) => approvals.blocks.get(toolName) ?? approvals.defaultBlock,
  shadowProxyToolCall: () => undefined,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentMcpEnablements: {
        findFirst: vi.fn(async () => ({ disabledTools: null })),
      },
      taskRuns: { findFirst: vi.fn(async () => ({ id: 42 })) },
    },
  },
  deploymentMcpEnablements: { mcpId: 'mcpId', enabled: 'enabled' },
  taskRuns: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  getTaskHumanOwnerUserIds: vi.fn(async () => []),
}));

vi.mock('@roomote/sdk/server', () => ({
  findLinearDeploymentMcpConnection: vi.fn(async () => ({ id: 'conn-1' })),
  getValidAccessToken: vi.fn(async () => 'linear-token'),
}));

import { createLinearMcp } from '../linear';

const runToken: RunTokenContext = {
  runId: 42,
  userId: null,
  principal: 'deployment',
  tokenType: 'run',
  version: 1,
};

function createApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', runToken);
    await next();
  });
  app.route('/linear', createLinearMcp());
  return app;
}

function post(body: unknown) {
  return createApp().request('/linear', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('createLinearMcp tool approval policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses a policy-blocked tool under the linear id without contacting Linear', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockResolveApprovalBlocks.mockResolvedValue({
      blocks: new Map([['save_issue', 'needs_approval']]),
      shadowDefaultTools: false,
    });

    const response = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'save_issue', arguments: {} },
    });

    expect(mockResolveApprovalBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: 'linear', tokenType: 'run' }),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
