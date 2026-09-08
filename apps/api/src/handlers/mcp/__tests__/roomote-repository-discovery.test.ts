import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createAuthToken, validateAuthToken } from '@roomote/auth';
import { configureAuthClientEnv } from '@roomote/auth/client';
import { db } from '@roomote/db/server';
import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
} from '@roomote/types';

import {
  clearFastAgentIntegrationToolCache,
  listFastAgentIntegrations,
} from '../../../../../../packages/cloud-agents/src/server/fast-agent/fast-agent-integration-broker';
import {
  buildFastAgentToolFilter,
  isFastAgentNativeIntegration,
} from '../../../../../../packages/cloud-agents/src/server/fast-agent/fast-agent-tool-policy';
import { getAllowedRouterMcpToolNames } from '../../../../../../packages/cloud-agents/src/server/mcp-policy';
import { listMcpTools } from '../../../../../../packages/cloud-agents/src/server/mcp-tool-client';
import type { Variables } from '../../../types';
import { publicRoomoteMcp, roomoteMcp } from '../roomote';

describe('Fast member repository discovery over public Roomote MCP', () => {
  const baseUrl = 'http://roomote-discovery.test';
  const userId = randomUUID();
  let requests: Array<{ path: string; method?: string; actor: string | null }>;

  beforeEach(() => {
    clearFastAgentIntegrationToolCache();
    requests = [];
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    configureAuthClientEnv({
      jobAuthPrivateKey: keys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      jobAuthPublicKey: keys.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    });
    // Discovery needs no repository data. Suppress only the optional GitHub
    // integration candidate, independently of whatever is in the test database.
    vi.spyOn(db.query.githubInstallations, 'findFirst').mockResolvedValue(
      undefined,
    );
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      const bearer = c.req.header('Authorization');
      if (!bearer?.startsWith('Bearer '))
        return c.json({ error: 'Unauthorized' }, 401);
      try {
        const auth = await validateAuthToken(bearer.slice(7));
        if (auth.userId !== userId)
          return c.json({ error: 'Wrong actor' }, 403);
        c.set('authContext', auth);
      } catch {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body =
        c.req.method === 'POST' ? await c.req.raw.clone().json() : undefined;
      requests.push({
        path: c.req.path,
        method: body?.method,
        actor: c.get('authContext')!.userId,
      });
      // Fail closed before any execution, including task startup or providers.
      if (body?.method === 'tools/call')
        throw new Error('Discovery must not execute tools');
      await next();
    });
    app.route('/mcp', publicRoomoteMcp);
    app.route('/api/mcp/roomote', roomoteMcp);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).origin !== baseUrl)
          throw new Error('Unexpected external request');
        return app.request(request);
      }),
    );
  });

  afterEach(() => {
    expect(requests.map(({ method }) => method).filter(Boolean)).not.toContain(
      'tools/call',
    );
    configureAuthClientEnv(null);
    clearFastAgentIntegrationToolCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('discovers real member schemas through the Fast broker and enables them natively', async () => {
    const integrations = await listFastAgentIntegrations(
      { userId, apiBaseUrl: baseUrl },
      async () => ({ roomote: { url: `${baseUrl}/mcp`, headers: {} } }),
    );
    expect(integrations).toHaveLength(1);
    const integration = integrations[0]!;
    expect(integration.id).toBe('roomote');
    expect(integration.endpoint).toMatchObject({
      url: `${baseUrl}/mcp`,
      deploymentProxy: true,
    });
    expect(isFastAgentNativeIntegration(integration.id)).toBe(true);
    expect(
      buildFastAgentToolFilter(integrations.map(({ id }) => id)),
    ).toMatchObject({
      '*': false,
      'roomote_*': true,
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        { path: '/mcp', method: 'initialize', actor: userId },
        { path: '/mcp', method: 'tools/list', actor: userId },
      ]),
    );
    expect(requests.every(({ path }) => path === '/mcp')).toBe(true);

    const schemas = new Map(
      integration.tools.map(({ name, inputSchema }) => [name, inputSchema]),
    );
    expect(schemas.get('read_repository')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['repositoryFullName', 'action']),
      properties: {
        action: {
          enum: [
            'get_repository',
            'get_file',
            'list_branches',
            'list_commits',
            'get_commit',
            'list_pull_requests',
            'get_pull_request',
            'get_pull_request_files',
            'get_pull_request_diff',
            'get_pull_request_checks',
            'get_pull_request_comments',
            'get_pull_request_review_comments',
            'get_pull_request_reviews',
            'search_code',
            'search_pull_requests',
          ],
        },
        searchTerms: expect.any(Object),
      },
    });
    for (const [name, fields] of [
      [
        'rename_pull_request',
        [
          'repositoryFullName',
          'environmentId',
          'prNumber',
          'userIntent',
          'title',
        ],
      ],
      [
        'close_pull_request',
        ['repositoryFullName', 'environmentId', 'prNumber', 'userIntent'],
      ],
    ] as const) {
      const schema = schemas.get(name) as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(Object.keys(schema.properties).sort()).toEqual([...fields].sort());
      expect(schema.required).toEqual(
        expect.arrayContaining(
          fields.filter((field) => field !== 'environmentId'),
        ),
      );
      expect(schema.properties).toMatchObject({
        prNumber: {
          type: 'integer',
          exclusiveMinimum: 0,
          maximum: 2_147_483_647,
        },
        userIntent: { type: 'string', minLength: 1, maxLength: 2000 },
      });
      if (name === 'rename_pull_request') {
        expect(schema.properties.title).toMatchObject({
          type: 'string',
          minLength: 1,
          maxLength: 256,
        });
      }
    }
  });

  it('keeps repository member tools off the legacy endpoint and router allowlist', async () => {
    const tools = await listMcpTools({
      url: `${baseUrl}/api/mcp/roomote`,
      headers: {
        Authorization: `Bearer ${await createAuthToken({ userId, timeoutMs: 60_000 })}`,
      },
    });
    const names = tools.map(({ name }) => name);
    expect(names).toContain('get_about_me');
    const allowed = getAllowedRouterMcpToolNames('roomote');
    expect(allowed).toEqual([
      'get_about_me',
      CHAT_CHANNEL_MESSAGES_TOOL.name,
      CHAT_MESSAGE_CONTEXT_TOOL.name,
    ]);
    for (const name of [
      'read_repository',
      'rename_pull_request',
      'close_pull_request',
    ]) {
      expect(names).not.toContain(name);
      expect(allowed).not.toContain(name);
      expect(getAllowedRouterMcpToolNames('github')).not.toContain(name);
    }
    expect(requests).toEqual(
      expect.arrayContaining([
        { path: '/api/mcp/roomote', method: 'tools/list', actor: userId },
      ]),
    );
  });

  it('rejects invalid bearer tokens rather than supplying an unchecked actor', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(response.status).toBe(401);
    expect(requests).toEqual([]);
  });
});
