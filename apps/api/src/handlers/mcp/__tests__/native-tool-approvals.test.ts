const { mockResolveBlocks, mockClaim } = vi.hoisted(() => ({
  mockResolveBlocks: vi.fn(async () => new Map<string, string>()),
  mockClaim: vi.fn(async () => false),
}));

vi.mock('../tool-approval-enforcement', () => ({
  claimProxyTaskToolCall: mockClaim,
  describeProxyToolApprovalBlock: (toolName: string, block: string) =>
    `${toolName}:${block}`,
  resolveProxyToolApprovalBlocks: mockResolveBlocks,
}));

vi.mock('../proxy-utils', () => ({
  getJsonRpcMethod: (body: { method?: unknown } | null) =>
    typeof body?.method === 'string' ? body.method : null,
  getJsonRpcRequestId: (body: { id?: unknown } | null) =>
    typeof body?.id === 'string' || typeof body?.id === 'number'
      ? body.id
      : null,
  getToolCallName: (
    body: { method?: unknown; params?: { name?: unknown } } | null,
  ) =>
    body?.method === 'tools/call' && typeof body.params?.name === 'string'
      ? body.params.name
      : null,
  jsonRpcErrorResponse: (
    status: number,
    code: number,
    message: string,
    id: string | number | null = null,
  ) =>
    Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status }),
  resolveRunTokenTaskId: vi.fn(async () => 'task-1'),
  resolveTaskOrSessionUserIdOrNull: vi.fn(async () => 'user-1'),
}));

import { resolveNativeToolApprovalGuard } from '../native-tool-approvals';

describe('resolveNativeToolApprovalGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBlocks.mockResolvedValue(new Map());
    mockClaim.mockResolvedValue(false);
  });

  it('hides disabled tools from native tools/list responses', async () => {
    mockResolveBlocks.mockResolvedValue(
      new Map([
        ['disabled_tool', 'reject'],
        ['ask_tool', 'needs_approval'],
      ]),
    );
    const guard = await resolveNativeToolApprovalGuard({
      auth: { userId: 'user-1', tokenType: 'auth' },
      integrationId: 'notion',
    });

    const response = await guard.filterToolsList(
      { method: 'tools/list' },
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            tools: [
              { name: 'safe_tool' },
              { name: 'disabled_tool' },
              { name: 'ask_tool' },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(
      ((await response.json()) as { result: { tools: { name: string }[] } })
        .result.tools,
    ).toEqual([{ name: 'safe_tool' }, { name: 'ask_tool' }]);
  });

  it('refuses disabled calls and only releases ask calls after approval', async () => {
    mockResolveBlocks.mockResolvedValue(
      new Map([
        ['disabled_tool', 'reject'],
        ['ask_tool', 'needs_approval'],
      ]),
    );
    const guard = await resolveNativeToolApprovalGuard({
      auth: { userId: null, tokenType: 'run', runId: 42 },
      integrationId: 'notion',
    });

    const disabled = await guard.checkCall({
      id: 1,
      method: 'tools/call',
      params: { name: 'disabled_tool', arguments: {} },
    });
    expect(disabled?.status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();

    const pending = await guard.checkCall({
      id: 2,
      method: 'tools/call',
      params: { name: 'ask_tool', arguments: {} },
    });
    expect(pending?.status).toBe(403);

    mockClaim.mockResolvedValue(true);
    await expect(
      guard.checkCall({
        id: 2,
        method: 'tools/call',
        params: { name: 'ask_tool', arguments: {} },
      }),
    ).resolves.toBeNull();
  });
});
