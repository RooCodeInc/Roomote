import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('MCP tool catalog pagination with the real SDK and local server', () => {
  afterEach(() => vi.restoreAllMocks());

  it('discovers and executes a later-page tool through its schema and durable provider receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roomote-mcp-pages-'));
    const receipt = join(directory, 'receipt.json');
    const cursors: Array<string | undefined> = [];
    const startEndpoint = () =>
      startMcpToolTestServer(
        (request) => {
          expect(request.params.name).toBe('write_note');
          writeFileSync(receipt, JSON.stringify(request.params.arguments));
          return { content: [{ type: 'text', text: '{"accepted":true}' }] };
        },
        {
          list(request) {
            cursors.push(request.params?.cursor);
            return request.params?.cursor === 'later'
              ? {
                  tools: [
                    {
                      name: 'write_note',
                      inputSchema: {
                        type: 'object',
                        properties: { note: { type: 'string' } },
                        required: ['note'],
                      },
                    },
                  ],
                }
              : {
                  tools: [
                    { name: 'read_first', inputSchema: { type: 'object' } },
                  ],
                  nextCursor: 'later',
                };
          },
        },
      );
    const endpoint = await startEndpoint();
    let callEndpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
    try {
      const names = (await listMcpTools({ url: endpoint.url })).map(
        ({ name }) => name,
      );
      const discoveryCursors = [...cursors];
      cursors.length = 0;
      callEndpoint = await startEndpoint();
      const result = await callMcpTool({
        url: callEndpoint.url,
        toolName: 'write_note',
        args: { note: 'disposable fixture' },
      });
      console.log({
        names,
        discoveryCursors,
        callCursors: [...cursors],
        result,
      });
      expect(names).toEqual(['read_first', 'write_note']);
      expect(discoveryCursors).toEqual([undefined, 'later']);
      expect(result).toEqual({ accepted: true });
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({
        note: 'disposable fixture',
      });
      expect(cursors).toEqual([undefined, 'later']);
    } finally {
      await endpoint.close();
      await callEndpoint?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['list', 'call'] as const)(
    'rejects repeated cursors during %s and closes the transport',
    async (operation) => {
      let pages = 0;
      const execute = vi.fn(() => ({ content: [] }));
      const endpoint = await startMcpToolTestServer(execute, {
        list() {
          pages++;
          return { tools: [], nextCursor: 'repeated' };
        },
      });
      const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
      try {
        const result =
          operation === 'list'
            ? listMcpTools({ url: endpoint.url })
            : callMcpTool({ url: endpoint.url, toolName: 'absent' });
        await expect(result).rejects.toThrow('repeated a pagination cursor');
        expect(pages).toBe(2);
        expect(execute).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await endpoint.close();
      }
    },
  );

  it('does not return a partial catalog when a later page fails', async () => {
    const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
      list(request) {
        if (request.params?.cursor)
          throw new McpError(ErrorCode.InternalError, 'later page unavailable');
        return {
          tools: [{ name: 'first', inputSchema: { type: 'object' } }],
          nextCursor: 'later',
        };
      },
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      await expect(listMcpTools({ url: endpoint.url })).rejects.toThrow(
        'later page unavailable',
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await endpoint.close();
    }
  });

  it('still calls an earlier-page tool without depending on a broken later page', async () => {
    const cursors: Array<string | undefined> = [];
    const endpoint = await startMcpToolTestServer(
      () => ({ content: [{ type: 'text', text: 'first page works' }] }),
      {
        list(request) {
          cursors.push(request.params?.cursor);
          if (request.params?.cursor)
            throw new McpError(
              ErrorCode.InternalError,
              'later page unavailable',
            );
          return {
            tools: [{ name: 'first', inputSchema: { type: 'object' } }],
            nextCursor: 'later',
          };
        },
      },
    );
    try {
      await expect(
        callMcpTool({ url: endpoint.url, toolName: 'first' }),
      ).resolves.toBe('first page works');
      expect(cursors).toEqual([undefined]);
    } finally {
      await endpoint.close();
    }
  });

  it('cancels discovery while a later page is pending and closes the transport', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = await startMcpToolTestServer(() => ({ content: [] }), {
      async list(request) {
        if (request.params?.cursor) {
          markStarted();
          await held;
          return { tools: [] };
        }
        return { tools: [], nextCursor: 'later' };
      },
    });
    const close = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    try {
      const controller = new AbortController();
      const rejected = expect(
        listMcpTools({ url: endpoint.url, signal: controller.signal }),
      ).rejects.toThrow();
      await started;
      controller.abort(new Error('cancel pending catalog page'));
      await rejected;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      release();
      await endpoint.close();
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
