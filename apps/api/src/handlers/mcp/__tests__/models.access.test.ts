import { serve } from '@hono/node-server';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import {
  createAuthToken,
  configureAuthClientEnv,
  createMcpAccessToken,
  getLegacyRoomoteMcpResourceUrl,
  getRoomoteMcpResourceUrl,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';
import {
  db,
  deploymentSettings,
  eq,
  userFactory,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { TaskModelOption } from '@roomote/types';
import { createApiApp } from '../../../server';
import { oauthGrantFixture } from './oauth-fixture';
import { isMcpOAuthGrantLive, revokeMcpOAuthGrants } from '@roomote/redis';

vi.mock('@roomote/redis', async (original) => {
  const actual = await original<typeof import('@roomote/redis')>();
  return { ...actual, isMcpOAuthGrantLive: vi.fn(actual.isMcpOAuthGrantLive) };
});

describe('model discovery through authenticated HTTP', () => {
  beforeAll(() => {
    const keys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    configureAuthClientEnv({
      jobAuthPrivateKey: Buffer.from(keys.privateKey).toString('base64'),
      jobAuthPublicKey: Buffer.from(keys.publicKey).toString('base64'),
    });
  });
  afterAll(() => configureAuthClientEnv(null));
  it('uses the real catalog, active account auth and public MCP adapter', async () => {
    const member = await userFactory.create({ role: 'member' });
    const other = await userFactory.create({ role: 'member' });
    const saved = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
    const models: TaskModelOption[] = [
      {
        id: 'anthropic/claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        family: 'Claude',
      },
      {
        id: 'openai/gpt-5.6-luna',
        displayName: 'GPT 5.6 Luna',
        family: 'GPT',
        metadata: {
          contextWindow: 400000,
          inputTypes: ['text'],
          inputPricePerToken: null,
          outputPricePerToken: null,
          lastRefreshedAt: null,
          supportsReasoning: true,
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      },
      { id: 'openrouter/z-ai/glm-5.2', displayName: 'GLM 5.2', family: 'GLM' },
      { id: 'openai/disabled-example', displayName: 'Disabled', family: 'GPT' },
    ];
    const taskModelSettings = {
      models,
      allowedModelIds: models.slice(0, 3).map((m) => m.id),
      defaultModelId: models[1]!.id,
    };
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', taskModelSettings })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { taskModelSettings },
      });
    const server = serve({
      fetch: createApiApp().fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP address');
    const base = `http://127.0.0.1:${address.port}`;
    const resource = getRoomoteMcpResourceUrl(
      Env.R_PUBLIC_URL ?? Env.R_APP_URL,
    );
    const token = await createMcpAccessToken({
      ...(await oauthGrantFixture(member.id, resource)),
      userId: member.id,
      resource,
      scopes: [ROOMOTE_MCP_SCOPE],
      timeoutMs: 60000,
    });
    const receipts: unknown[] = [];
    async function get(path: string, bearer: string | null = token) {
      vi.mocked(isMcpOAuthGrantLive).mockClear();
      const response = await fetch(`${base}${path}`, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      });
      const body = await response.json();
      expect(
        vi.mocked(isMcpOAuthGrantLive).mock.calls.length,
      ).toBeLessThanOrEqual(1);
      receipts.push({
        method: 'GET',
        path,
        authentication: bearer ? 'account bearer (omitted)' : 'none',
        status: response.status,
        body,
      });
      return { response, body };
    }
    try {
      const first = await get('/mcp/models?limit=1');
      expect(first.response.status).toBe(200);
      expect(first.response.headers.get('cache-control')).toBe(
        'no-store, private',
      );
      expect(first.body.models.map((m: { id: string }) => m.id)).toEqual([
        models[0]!.id,
      ]);
      const later = await get(
        `/mcp/models?limit=1&cursor=${first.body.nextCursor}`,
      );
      expect(later.body.models[0]).toMatchObject({
        ...models[1],
        isDefault: true,
      });
      const filtered = await get('/mcp/models?query=gPt&limit=1');
      expect(filtered.body.models).toEqual(later.body.models);
      expect(filtered.body.nextCursor).toBeNull();
      const all = await get('/mcp/models');
      expect(all.body.models.map((m: { id: string }) => m.id)).toEqual(
        models.slice(0, 3).map((m) => m.id),
      );
      const otherToken = await createAuthToken({
        userId: other.id,
        timeoutMs: 60000,
      });
      expect((await get('/mcp/models', otherToken)).body).toEqual(all.body);
      expect((await get('/mcp/models', null)).response.status).toBe(401);
      const wrong = await createMcpAccessToken({
        ...(await oauthGrantFixture(member.id, resource)),
        userId: member.id,
        resource: 'https://wrong.example/mcp',
        scopes: [ROOMOTE_MCP_SCOPE],
        timeoutMs: 60000,
      });
      expect((await get('/mcp/models', wrong)).response.status).toBe(403);
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, other.id));
      expect((await get('/mcp/models', otherToken)).response.status).toBe(401);

      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'manage_tasks',
          arguments: { action: 'list_models', limit: 1, query: 'GPT' },
        },
      };
      vi.mocked(isMcpOAuthGrantLive).mockClear();
      const result = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(rpc),
      });
      const text = await result.text();
      expect(result.status).toBe(200);
      expect(text).toContain(models[1]!.id);
      expect(text).not.toContain('Unknown action');
      expect(text).not.toContain('"isError":true');
      expect(isMcpOAuthGrantLive).toHaveBeenCalledOnce();
      const legacyResource = getLegacyRoomoteMcpResourceUrl(Env.TRPC_URL);
      const legacy = await createMcpAccessToken({
        ...(await oauthGrantFixture(member.id, legacyResource)),
        userId: member.id,
        resource: legacyResource,
        scopes: [ROOMOTE_MCP_SCOPE],
        timeoutMs: 60000,
      });
      const initialize = async (path: string, bearer: string) => {
        vi.mocked(isMcpOAuthGrantLive).mockClear();
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'auth-test', version: '1' },
            },
          }),
        });
        await response.text();
        expect(isMcpOAuthGrantLive).toHaveBeenCalledOnce();
        return response.status;
      };
      expect(await initialize('/api/mcp-routing/roomote', legacy)).toBe(200);
      expect(vi.mocked(isMcpOAuthGrantLive).mock.calls[0]![0]).toMatchObject({
        resource: legacyResource,
      });
      expect(await initialize('/mcp', legacy)).toBe(403);
      expect((await get('/mcp/models', legacy)).response.status).toBe(403);
      expect(
        (await get('/mcp/task-outputs/download', legacy)).response.status,
      ).toBe(403);
      // A live-grant storage failure must not fall back to member access on any
      // mounted OAuth surface, and the next request must try Redis again.
      for (const path of ['/mcp/models', '/mcp/task-outputs/download']) {
        vi.mocked(isMcpOAuthGrantLive).mockRejectedValueOnce(
          new Error('Redis unavailable'),
        );
        expect((await get(path)).response.status).toBe(401);
        expect(isMcpOAuthGrantLive).toHaveBeenCalledOnce();
      }
      for (const [path, bearer] of [
        ['/mcp', token],
        ['/api/mcp-routing/roomote', legacy],
      ] as const) {
        vi.mocked(isMcpOAuthGrantLive).mockRejectedValueOnce(
          new Error('Redis unavailable'),
        );
        expect(await initialize(path, bearer)).toBe(401);
      }
      expect((await get('/mcp/models')).response.status).toBe(200);
      await revokeMcpOAuthGrants(member.id);
      expect(await initialize('/api/mcp-routing/roomote', legacy)).toBe(401);
      expect((await get('/mcp/models')).response.status).toBe(401);
      expect((await get('/mcp/task-outputs/download')).response.status).toBe(
        401,
      );
      const revokedMcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(rpc),
      });
      expect(revokedMcp.status).toBe(401);
      const reconnected = await createMcpAccessToken({
        ...(await oauthGrantFixture(member.id, resource)),
        userId: member.id,
        resource,
        scopes: [ROOMOTE_MCP_SCOPE],
        timeoutMs: 60000,
      });
      expect((await get('/mcp/models', reconnected)).response.status).toBe(200);
      expect((await get('/mcp/models')).response.status).toBe(401);
      expect((await get('/mcp/task-outputs/download')).response.status).toBe(
        401,
      );
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, member.id));
      expect((await get('/mcp/models', reconnected)).response.status).toBe(401);
      receipts.push({
        method: 'POST',
        path: '/mcp',
        request: rpc,
        status: result.status,
        responseText: text,
      });
      if (process.env.ROOMOTE_MODEL_PROOF_PATH)
        await writeFile(
          process.env.ROOMOTE_MODEL_PROOF_PATH,
          JSON.stringify(
            {
              fixture:
                'Local test database; enabled catalog explicitly seeded for deterministic proof; no provider call',
              receipts,
            },
            null,
            2,
          ),
        );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (saved)
        await db
          .update(deploymentSettings)
          .set({ taskModelSettings: saved.taskModelSettings })
          .where(eq(deploymentSettings.id, 'default'));
      else
        await db
          .delete(deploymentSettings)
          .where(eq(deploymentSettings.id, 'default'));
      await db.delete(users).where(eq(users.id, member.id));
      await db.delete(users).where(eq(users.id, other.id));
    }
  }, 30000);
});
