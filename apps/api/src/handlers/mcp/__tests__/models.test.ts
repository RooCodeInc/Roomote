import { Hono } from 'hono';
import { getRoomoteMcpResourceUrl, ROOMOTE_MCP_SCOPE } from '@roomote/auth';
import { Env } from '@roomote/env';
import type { TaskModelOption } from '@roomote/types';
import type { Variables } from '../../../types';
import { listMemberModels } from '../models';

const { options } = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('@roomote/db/server', async (original) => ({
  ...(await original<typeof import('@roomote/db/server')>()),
  getDeploymentTaskModelOptions: options,
}));

const model = (id: string, displayName = id): TaskModelOption => ({
  id,
  displayName,
  family: 'Example',
});
function app(
  auth: Variables['authContext'] | null = {
    userId: 'member',
    tokenType: 'auth',
    version: 1,
  },
) {
  const router = new Hono<{ Variables: Variables }>();
  router.use('*', async (c, next) => {
    c.set('authContext', auth ?? undefined);
    await next();
  });
  router.get('/models', listMemberModels);
  return router;
}

describe('member model discovery', () => {
  beforeEach(() => options.mockReset());

  it('bounds large catalogs and traverses IDs without gaps or duplicates', async () => {
    const models = Array.from({ length: 235 }, (_, i) =>
      model(`openai/example-${String(i).padStart(3, '0')}`),
    ).reverse();
    options.mockResolvedValue({ models, defaultModelId: models[0]!.id });
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const response = await app().request(
        `/models${cursor ? `?cursor=${cursor}` : ''}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.models.length).toBeLessThanOrEqual(50);
      seen.push(...page.models.map((m: TaskModelOption) => m.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(models.map((m) => m.id).sort());
    expect(new Set(seen).size).toBe(235);
  });

  it('filters before pagination by case-insensitive ID, name and family; keeps default and metadata', async () => {
    const metadata = {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportsReasoning: true,
      supportedReasoningEfforts: ['low', 'high'],
    };
    options.mockResolvedValue({
      models: [
        model('openai/a', 'Special Name'),
        { ...model('openai/b'), metadata },
        model('openai/c', 'Special Name'),
      ],
      defaultModelId: 'openai/b',
    });
    const first = await (
      await app().request('/models?query= SPECIAL &limit=1')
    ).json();
    expect(first.models.map((m: TaskModelOption) => m.id)).toEqual([
      'openai/a',
    ]);
    expect(first.defaultModelId).toBe('openai/b');
    const last = await (
      await app().request(
        `/models?query=special&limit=1&cursor=${first.nextCursor}`,
      )
    ).json();
    expect(last.models.map((m: TaskModelOption) => m.id)).toEqual(['openai/c']);
    expect(last.nextCursor).toBeNull();
    const exact = await (await app().request('/models?query=OPENAI/B')).json();
    expect(exact.models[0]).toMatchObject({
      id: 'openai/b',
      metadata,
      isDefault: true,
    });
    expect(
      (await (await app().request('/models?query=example')).json()).models,
    ).toHaveLength(3);
    expect(
      (await (await app().request('/models?query=absent')).json()).models,
    ).toEqual([]);
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=NaN',
    'limit=',
    'cursor=',
    'cursor=garbage',
    `query=${'x'.repeat(201)}`,
  ])('rejects invalid %s', async (query) => {
    expect((await app().request(`/models?${query}`)).status).toBe(400);
    expect(options).not.toHaveBeenCalled();
  });

  it('rejects a cursor reused with a different filter', async () => {
    options.mockResolvedValue({
      models: [model('openai/a'), model('openai/b')],
      defaultModelId: 'openai/a',
    });
    const first = await (await app().request('/models?limit=1')).json();
    expect(
      (await app().request(`/models?cursor=${first.nextCursor}&query=other`))
        .status,
    ).toBe(400);
  });

  it('enforces member credential type, resource and scope before catalog reads', async () => {
    const mcp = {
      tokenType: 'mcp' as const,
      version: 1,
      userId: 'member',
      resource: getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
      scopes: [ROOMOTE_MCP_SCOPE],
    };
    for (const [auth, status] of [
      [undefined, 401],
      [
        {
          tokenType: 'run',
          runId: 1,
          userId: 'member',
          version: 1,
          principal: 'user',
        },
        403,
      ],
      [{ ...mcp, resource: 'https://wrong.example/mcp' }, 403],
      [{ ...mcp, scopes: [] }, 403],
    ] as Array<[Variables['authContext'], number]>) {
      const response = await app(auth ?? null).request('/models');
      expect(response.status).toBe(status);
    }
    expect(options).not.toHaveBeenCalled();
    options.mockResolvedValue({ models: [], defaultModelId: 'openai/a' });
    expect((await app(mcp).request('/models')).status).toBe(200);
  });
});
