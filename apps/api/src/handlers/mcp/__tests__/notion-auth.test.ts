import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockFindConnection,
  mockFindEnablement,
  mockEq,
  mockAnd,
  mockIsNull,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindConnection: vi.fn(),
  mockFindEnablement: vi.fn(),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...clauses: unknown[]) => clauses),
  mockIsNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
      mcpConnections: { findFirst: mockFindConnection },
      deploymentMcpEnablements: { findFirst: mockFindEnablement },
    },
  },
  taskRuns: { id: 'taskRun.id' },
  mcpConnections: {
    mcpId: 'connection.mcpId',
    enabled: 'connection.enabled',
    authStatus: 'connection.authStatus',
    userId: 'connection.userId',
  },
  deploymentMcpEnablements: {
    mcpId: 'enablement.mcpId',
    enabled: 'enablement.enabled',
  },
  eq: mockEq,
  and: mockAnd,
  isNull: mockIsNull,
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

import { notionMcp } from '../notion';

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
    ...overrides,
  };
}

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.route('/mcp', notionMcp);
  return app;
}

async function postMcp(app: Hono<{ Variables: Variables }>, body: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createToolCallRequest(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

describe('native Notion MCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockFindConnection.mockResolvedValue({
      id: 'conn-notion',
      userId: null,
      mcpId: 'notion',
      enabled: true,
      authStatus: 'authenticated',
      authConfig: {
        type: 'notion',
        encryptedToken: 'enc:notion-internal-secret',
      },
    });
    mockFindEnablement.mockResolvedValue({
      mcpId: 'notion',
    });
  });

  it('exposes tools whose permissions are enforced by Notion capabilities', async () => {
    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = body.result.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'notion-search',
        'notion-fetch',
        'notion-query-data-sources',
        'notion-get-comments',
        'notion-create-pages',
        'notion-update-page',
        'notion-fetch-page-markdown',
        'notion-update-page-markdown',
        'notion-get-async-task',
        'notion-move-page',
        'notion-append-blocks',
        'notion-create-comment',
      ]),
    );
  });

  it('searches through the Notion API using only the stored integration secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-search', { query: 'roadmap' }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/search'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer notion-internal-secret',
          'Notion-Version': '2026-03-11',
        }),
      }),
    );
  });

  it('inserts newly created blocks at the beginning of a page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'list', results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const children = [{ object: 'block', type: 'divider', divider: {} }];

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-append-blocks', {
        block_id: 'parent-page',
        children,
        position: { type: 'start' },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/blocks/parent-page/children'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ children, position: { type: 'start' } }),
      }),
    );
  });

  it('inserts newly created blocks after an existing child block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'list', results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const children = [{ object: 'block', type: 'divider', divider: {} }];

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-append-blocks', {
        block_id: 'parent-page',
        children,
        position: {
          type: 'after_block',
          after_block: { id: 'existing-block' },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/blocks/parent-page/children'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          children,
          position: {
            type: 'after_block',
            after_block: { id: 'existing-block' },
          },
        }),
      }),
    );
  });

  it('moves a regular page to an editable parent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'page', id: 'child-page' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-move-page', {
        page_id: 'child-page',
        parent: { type: 'page_id', page_id: 'new-parent' },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/pages/child-page/move'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'page_id', page_id: 'new-parent' },
        }),
      }),
    );
  });

  it('reads and updates page content as enhanced Markdown', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ object: 'page_markdown', markdown: '# Plan' }),
      )
      .mockResolvedValueOnce(
        Response.json({ object: 'page_markdown', markdown: '# Updated plan' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          object: 'async_task',
          id: 'task-1',
          status: 'running',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(createRunToken());

    const readResponse = await postMcp(
      app,
      createToolCallRequest('notion-fetch-page-markdown', {
        page_id: 'plan-page',
        include_transcript: true,
      }),
    );
    const updateResponse = await postMcp(
      app,
      createToolCallRequest('notion-update-page-markdown', {
        page_id: 'plan-page',
        operation: {
          type: 'update_content',
          update_content: {
            content_updates: [{ old_str: '# Plan', new_str: '# Updated plan' }],
          },
        },
      }),
    );
    const taskResponse = await postMcp(
      app,
      createToolCallRequest('notion-get-async-task', { task_id: 'task-1' }),
    );

    expect(readResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(taskResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL(
        'https://api.notion.com/v1/pages/plan-page/markdown?include_transcript=true',
      ),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL('https://api.notion.com/v1/pages/plan-page/markdown'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          type: 'update_content',
          update_content: {
            content_updates: [{ old_str: '# Plan', new_str: '# Updated plan' }],
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      new URL('https://api.notion.com/v1/async_tasks/task-1'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects legacy hosted-MCP OAuth credentials', async () => {
    mockFindConnection.mockResolvedValue({
      authConfig: {
        type: 'oauth_client',
        client_id: 'legacy',
        registered_redirect_uri: 'https://example.com/callback',
      },
    });

    const response = await postMcp(createApp(createRunToken()), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(500);
    expect(body.error.message).toContain('internal integration configuration');
  });
});
