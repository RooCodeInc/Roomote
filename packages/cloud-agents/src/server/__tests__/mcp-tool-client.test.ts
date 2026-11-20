import { createServer } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { formatErrorForLog } from '@roomote/types';
import {
  callMcpTool,
  extractMcpToolResultPayload,
  listMcpTools,
  isMcpAuthenticationError,
  McpToolCallError,
} from '../mcp-tool-client';
import { startMcpToolTestServer } from './mcp-tool-client-fixture';

describe('MCP tool client cancellation', () => {
  it('aborts the initialization transport when discovery is cancelled', async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let markRequestClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => {
      markRequestClosed = resolve;
    });
    const server = createServer((request) => {
      markRequestStarted();
      request.once('aborted', markRequestClosed);
      request.once('close', markRequestClosed);
      // Deliberately leave MCP initialization unanswered until the caller
      // aborts, reproducing a nonresponsive integration proxy.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test MCP server did not receive a TCP address.');
    }

    try {
      const abortController = new AbortController();
      const discovery = listMcpTools({
        url: `http://127.0.0.1:${address.port}/mcp`,
        signal: abortController.signal,
      });
      const rejected = expect(discovery).rejects.toThrow();
      await requestStarted;

      abortController.abort(new Error('test discovery timeout'));

      await rejected;
      await Promise.race([
        requestClosed,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('MCP request remained open after abort.')),
            1_000,
          );
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('extractMcpToolResultPayload', () => {
  it.each([
    [undefined, null],
    [null, null],
    [false, false],
    [0, 0],
    ['text', 'text'],
    [
      {
        structuredContent: { ok: true },
        content: [{ type: 'text', text: 'ignored' }],
      },
      { ok: true },
    ],
    [{ structuredContent: false }, false],
    [
      { structuredContent: null, content: [{ type: 'text', text: 'null' }] },
      null,
    ],
    [{ content: [{ type: 'text', text: '{"ok":true}' }] }, { ok: true }],
    [{ content: [{ type: 'text', text: 'plain text' }] }, 'plain text'],
    [{ content: [] }, []],
    [{ content: [{ type: 'image' }] }, [{ type: 'image' }]],
    [{ custom: true }, { custom: true }],
  ])('preserves extraction behavior for %j', (input, expected) => {
    expect(extractMcpToolResultPayload(input)).toEqual(expected);
  });
});

describe('callMcpTool with the real AI SDK and local MCP server', () => {
  afterEach(() => vi.restoreAllMocks());

  it('discovers tools from a stateless server through the standard handshake', async () => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      methods.push(message.method);
      expect(request.headers['mcp-session-id']).toBeUndefined();
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'initialize'
              ? {
                  protocolVersion: message.params.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: 'stateless-test', version: '1.0.0' },
                }
              : {
                  tools: [
                    {
                      name: 'integration_request',
                      inputSchema: { type: 'object' },
                    },
                  ],
                },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    try {
      await expect(
        listMcpTools({ url: `http://127.0.0.1:${address.port}/mcp` }),
      ).resolves.toMatchObject([{ name: 'integration_request' }]);
      expect(methods).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retains annotations across initialized catalog pages and forwards auth/session headers', async () => {
    const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
      listTools: (request) =>
        request.params?.cursor === 'next'
          ? {
              tools: [
                {
                  name: 'write',
                  inputSchema: { type: 'object' },
                  annotations: { readOnlyHint: false },
                },
              ],
            }
          : {
              tools: [
                {
                  name: 'read',
                  inputSchema: { type: 'object' },
                  annotations: { readOnlyHint: true, title: 'Read' },
                },
              ],
              nextCursor: 'next',
            },
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(
        listMcpTools({
          url: endpoint.url,
          headers: { 'x-test-auth': 'catalog' },
        }),
      ).resolves.toMatchObject([
        { name: 'read', annotations: { readOnlyHint: true, title: 'Read' } },
        { name: 'write', annotations: { readOnlyHint: false } },
      ]);
      const posts = endpoint.requests.filter(
        (request) => request.method === 'POST',
      );
      expect(posts).toHaveLength(4); // initialize, initialized, two list pages
      expect(posts[0]?.headers['mcp-session-id']).toBeUndefined();
      const sessionId = posts[1]?.headers['mcp-session-id'];
      expect(sessionId).toEqual(expect.any(String));
      expect(
        posts
          .slice(1)
          .every((request) => request.headers['mcp-session-id'] === sessionId),
      ).toBe(true);
      expect(
        posts.every((request) => request.headers['x-test-auth'] === 'catalog'),
      ).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it.each(['failure', 'cancellation'])(
    'closes the transport after later-page %s without returning a partial catalog',
    async (mode) => {
      const controller = new AbortController();
      let pageStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        pageStarted = resolve;
      });
      const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
        listTools: async (request) => {
          if (!request.params?.cursor) return { tools: [], nextCursor: 'next' };
          pageStarted();
          if (mode === 'failure')
            throw new McpError(ErrorCode.InternalError, 'later page failed');
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          return { tools: [] };
        },
      });
      const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
      try {
        const discovery = listMcpTools({
          url: endpoint.url,
          signal: controller.signal,
        });
        const rejected = expect(discovery).rejects.toThrow();
        await started;
        if (mode === 'cancellation') controller.abort();
        await rejected;
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await endpoint.close();
      }
    },
  );

  it.each(['list', 'call'])(
    'follows paginated flat tools for %s',
    async (operation) => {
      const listTools = vi.fn((request: ListToolsRequest) =>
        request.params?.cursor === 'jira-page-2'
          ? {
              tools: [
                {
                  name: 'getJiraIssue',
                  inputSchema: { type: 'object' as const },
                },
              ],
            }
          : { tools: [], nextCursor: 'jira-page-2' },
      );
      const call = vi.fn(() => ({
        content: [{ type: 'text' as const, text: '{"key":"TEST-1"}' }],
      }));
      const endpoint = await startMcpToolTestServer(call, { listTools });
      try {
        if (operation === 'list') {
          await expect(listMcpTools({ url: endpoint.url })).resolves.toEqual([
            { name: 'getJiraIssue', inputSchema: { type: 'object' } },
          ]);
        } else {
          await expect(
            callMcpTool({ url: endpoint.url, toolName: 'getJiraIssue' }),
          ).resolves.toEqual({ key: 'TEST-1' });
          expect(call).toHaveBeenCalledOnce();
        }
        expect(listTools).toHaveBeenCalledTimes(2);
        expect(listTools.mock.calls[1]?.[0].params?.cursor).toBe('jira-page-2');
      } finally {
        await endpoint.close();
      }
    },
  );

  it('rejects repeated catalog cursors and closes the transport', async () => {
    const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
      listTools: () => ({ tools: [], nextCursor: 'repeated' }),
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(listMcpTools({ url: endpoint.url })).rejects.toThrow(
        'pagination did not terminate',
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it.each<{ name: string; result: CallToolResult; expected: unknown }>([
    {
      name: 'structured success',
      result: {
        isError: false,
        structuredContent: { ok: true },
        content: [{ type: 'text', text: 'ignored' }],
      },
      expected: { ok: true },
    },
    {
      name: 'JSON text success',
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      expected: { ok: true },
    },
    {
      name: 'null success',
      result: { content: [{ type: 'text', text: 'null' }] },
      expected: null,
    },
    {
      name: 'plain text success',
      result: { content: [{ type: 'text', text: 'allowed' }] },
      expected: 'allowed',
    },
  ])('returns $name and closes the transport', async ({ result, expected }) => {
    const endpoint = await startMcpToolTestServer(() => result);
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(
        callMcpTool({ url: endpoint.url, toolName: 'integration_request' }),
      ).resolves.toEqual(expected);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it.each<CallToolResult>([
    {
      isError: true,
      content: [{ type: 'text', text: 'POST denied: synthetic-secret' }],
    },
    {
      isError: true,
      structuredContent: {
        error: 'permission revoked',
        token: 'synthetic-secret',
      },
      content: [],
    },
    { isError: true, content: [] },
  ])('throws a safe typed error for an MCP error result %j', async (result) => {
    const endpoint = await startMcpToolTestServer(() => result);
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      const error = await callMcpTool({
        url: endpoint.url,
        toolName: 'integration_request',
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(McpToolCallError);
      expect(formatErrorForLog(error)).toBe(
        'McpToolCallError | MCP tool reported an error (isError: true).',
      );
      expect(JSON.stringify(error)).not.toContain('synthetic-secret');
      expect(error).not.toHaveProperty('cause');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it('preserves protocol failures and closes the transport', async () => {
    const endpoint = await startMcpToolTestServer(() => {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments');
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(
        callMcpTool({ url: endpoint.url, toolName: 'integration_request' }),
      ).rejects.toThrow('Invalid tool arguments');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it('closes the transport when the HTTP handshake fails', async () => {
    const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
      httpFailure: true,
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(
        callMcpTool({ url: endpoint.url, toolName: 'integration_request' }),
      ).rejects.toThrow('503');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it('recognizes actual SDK HTTP authentication failures without relying on the Error name', async () => {
    const server = createServer((_request, response) =>
      response.writeHead(401).end('synthetic-secret'),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    try {
      const error = await listMcpTools({
        url: `http://127.0.0.1:${address.port}/mcp`,
      }).catch((error: unknown) => error);
      expect(isMcpAuthenticationError(error)).toBe(true);
      expect(
        isMcpAuthenticationError(new Error('wrapped', { cause: error })),
      ).toBe(true);
      const cyclic = new Error('not auth');
      cyclic.cause = cyclic;
      expect(isMcpAuthenticationError(cyclic)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns null for an absent tool without executing and closes the transport', async () => {
    const call = vi.fn(() => ({ content: [] }));
    const endpoint = await startMcpToolTestServer(call);
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(
        callMcpTool({ url: endpoint.url, toolName: 'absent' }),
      ).resolves.toBeNull();
      expect(call).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });
});

describe('MCP error result extraction', () => {
  it('rejects an error result before considering structured content', () => {
    const errorText =
      'missing_required_fields: severity_id is required because manual triage is disabled';

    expect(() =>
      extractMcpToolResultPayload({
        isError: true,
        structuredContent: {
          created_at: '',
          external_id: 0,
          id: '',
          mode: '',
          name: '',
          permalink: '',
          reference: '',
          reported_at: '',
          status: '',
        },
        content: [{ type: 'text', text: errorText }],
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'McpToolCallError',
        upstreamText: errorText,
      }),
    );
  });
});
