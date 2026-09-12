import { createServer } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { formatErrorForLog } from '@roomote/types';
import {
  callMcpTool,
  extractMcpToolResultPayload,
  listMcpTools,
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
