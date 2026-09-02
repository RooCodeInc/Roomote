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
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      };
    };
    const toolNames = body.result.tools.map((tool) => tool.name);
    const insertBlocksTool = body.result.tools.find(
      (tool) => tool.name === 'notion-insert-blocks',
    );

    expect(response.status).toBe(200);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'notion-search',
        'notion-fetch',
        'notion-query-data-sources',
        'notion-get-comments',
        'notion-create-pages',
        'notion-create-database',
        'notion-update-database',
        'notion-update-data-source',
        'notion-create-view',
        'notion-update-view',
        'notion-delete-view',
        'notion-update-page',
        'notion-get-async-task',
        'notion-move-pages',
        'notion-insert-blocks',
        'notion-create-comment',
      ]),
    );
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        'notion-append-blocks',
        'notion-fetch-page-markdown',
        'notion-update-page-markdown',
      ]),
    );
    expect(insertBlocksTool?.inputSchema.properties).not.toHaveProperty(
      'after',
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
      createToolCallRequest('notion-insert-blocks', {
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

  it('creates a database with its initial data source and table view', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'database',
        id: 'database-id',
        data_sources: [{ id: 'data-source-id', name: 'Projects' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const title = [{ type: 'text', text: { content: 'Projects' } }];
    const description = [
      { type: 'text', text: { content: 'Active projects' } },
    ];
    const initialDataSource = {
      properties: {
        Name: { type: 'title', title: {} },
        Status: { type: 'status', status: {} },
      },
    };

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-create-database', {
        parent: { type: 'page_id', page_id: 'parent-page' },
        title,
        description,
        is_inline: true,
        initial_data_source: initialDataSource,
        icon: {
          type: 'external',
          external: { url: 'https://example.com/icon.png' },
        },
        cover: { type: 'external', external: { url: 'https://example.com' } },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/databases'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'page_id', page_id: 'parent-page' },
          title,
          description,
          is_inline: true,
          initial_data_source: initialDataSource,
          icon: {
            type: 'external',
            external: { url: 'https://example.com/icon.png' },
          },
          cover: {
            type: 'external',
            external: { url: 'https://example.com' },
          },
        }),
      }),
    );
  });

  it('validates database parents before calling Notion', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-create-database', {
        parent: { type: 'workspace', workspace: false },
      }),
    );
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('workspace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Notion capability errors from database creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          object: 'error',
          code: 'restricted_resource',
          message: 'This integration does not have Insert content capability.',
        },
        { status: 403 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-create-database', {
        parent: { type: 'page_id', page_id: 'parent-page' },
      }),
    );
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain(
      'does not have Insert content capability',
    );
  });

  it('updates supported database metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'database', id: 'database' }));
    vi.stubGlobal('fetch', fetchMock);
    const title = [{ type: 'text', text: { content: 'Projects 2027' } }];
    const description = [
      { type: 'text', text: { content: 'Upcoming projects' } },
    ];

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-update-database', {
        database_id: 'database',
        parent: { type: 'page_id', page_id: 'new-parent' },
        title,
        description,
        is_inline: false,
        icon: {
          type: 'external',
          external: { url: 'https://example.com/icon.png' },
        },
        cover: { type: 'external', external: { url: 'https://example.com' } },
        in_trash: false,
        is_locked: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/databases/database'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          parent: { type: 'page_id', page_id: 'new-parent' },
          title,
          description,
          is_inline: false,
          icon: {
            type: 'external',
            external: { url: 'https://example.com/icon.png' },
          },
          cover: {
            type: 'external',
            external: { url: 'https://example.com' },
          },
          in_trash: false,
          is_locked: true,
        }),
      }),
    );
  });

  it('adds, renames, and deletes data source properties', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ object: 'data_source', id: 'data-source' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const properties = {
      Priority: {
        type: 'select',
        select: { options: [{ name: 'High', color: 'red' }] },
      },
      'status-property-id': { name: 'Stage' },
      'obsolete-property-id': null,
    };

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-update-data-source', {
        data_source_id: 'data-source',
        title: [{ type: 'text', text: { content: 'Project tracker' } }],
        icon: null,
        properties,
        parent: { type: 'database_id', database_id: 'new-database' },
        in_trash: false,
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/data_sources/data-source'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          title: [{ type: 'text', text: { content: 'Project tracker' } }],
          icon: null,
          properties,
          parent: { type: 'database_id', database_id: 'new-database' },
          in_trash: false,
        }),
      }),
    );
  });

  it('creates and updates database views', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ object: 'view', id: 'new-view' }))
      .mockResolvedValueOnce(
        Response.json({ object: 'view', id: 'existing-view' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(createRunToken());

    const createResponse = await postMcp(
      app,
      createToolCallRequest('notion-create-view', {
        parent: { type: 'database_id', database_id: 'database' },
        data_source_id: 'data-source',
        name: 'High priority',
        type: 'table',
        filter: {
          property: 'Priority',
          select: { equals: 'High' },
        },
        sorts: [{ property: 'Name', direction: 'ascending' }],
        configuration: { type: 'table', wrap_cells: true },
        position: { type: 'end' },
      }),
    );
    const updateResponse = await postMcp(
      app,
      createToolCallRequest('notion-update-view', {
        view_id: 'existing-view',
        name: 'All priorities',
        filter: null,
        sorts: null,
        quick_filters: { Priority: null },
        configuration: { type: 'table', wrap_cells: false },
      }),
    );

    expect(createResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL('https://api.notion.com/v1/views'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          database_id: 'database',
          data_source_id: 'data-source',
          name: 'High priority',
          type: 'table',
          filter: {
            property: 'Priority',
            select: { equals: 'High' },
          },
          sorts: [{ property: 'Name', direction: 'ascending' }],
          configuration: { type: 'table', wrap_cells: true },
          position: { type: 'end' },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL('https://api.notion.com/v1/views/existing-view'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          name: 'All priorities',
          filter: null,
          sorts: null,
          quick_filters: { Priority: null },
          configuration: { type: 'table', wrap_cells: false },
        }),
      }),
    );
  });

  it('deletes a database view', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'view', id: 'old-view' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-delete-view', { view_id: 'old-view' }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.notion.com/v1/views/old-view'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it.each([
    ['notion-update-database', { database_id: 'database' }],
    ['notion-update-data-source', { data_source_id: 'data-source' }],
    ['notion-update-view', { view_id: 'view' }],
  ])('rejects empty %s calls', async (toolName, args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest(toolName, args),
    );
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('at least one');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inserts newly created blocks after an existing child block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ object: 'list', results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const children = [{ object: 'block', type: 'divider', divider: {} }];

    const response = await postMcp(
      createApp(createRunToken()),
      createToolCallRequest('notion-insert-blocks', {
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
      createToolCallRequest('notion-move-pages', {
        page_ids: ['child-page'],
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
      .mockResolvedValueOnce(Response.json({ object: 'page', id: 'plan-page' }))
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
      createToolCallRequest('notion-fetch', {
        id: 'plan-page',
        object_type: 'page',
        include_transcript: true,
      }),
    );
    const updateResponse = await postMcp(
      app,
      createToolCallRequest('notion-update-page', {
        page_id: 'plan-page',
        content: {
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
      new URL('https://api.notion.com/v1/pages/plan-page'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL(
        'https://api.notion.com/v1/pages/plan-page/markdown?include_transcript=true',
      ),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
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
      4,
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
