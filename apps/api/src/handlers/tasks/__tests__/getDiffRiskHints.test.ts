import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const mocks = vi.hoisted(() => ({
  screenDiffRiskHints: vi.fn(),
  rows: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  DIFF_RISK_HINTS_MAX_DIFF_CHARS: 400_000,
  screenDiffRiskHints: mocks.screenDiffRiskHints,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: mocks.rows }) }),
      }),
    }),
  },
  eq: vi.fn(),
  tasks: {},
  taskRuns: {},
}));

import { getDiffRiskHints } from '../getDiffRiskHints';

function post(body: unknown, authContext: unknown = { runId: 42 }) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', { userId: undefined, authContext: authContext as never });
    await next();
  });
  app.post('/tasks/runs/:runId/diff_risk_hints', getDiffRiskHints);

  return app.request('/tasks/runs/42/diff_risk_hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('getDiffRiskHints', () => {
  beforeEach(() => {
    mocks.rows.mockReset().mockResolvedValue([{ title: 'Fix admin check' }]);
    mocks.screenDiffRiskHints
      .mockReset()
      .mockResolvedValue({ available: true, hints: [], text: 'none flagged' });
  });

  it("screens the diff with the run's task title", async () => {
    const response = await post({ diff: 'diff --git a/a b/a' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ available: true });
    expect(mocks.screenDiffRiskHints).toHaveBeenCalledWith({
      title: 'Fix admin check',
      diff: 'diff --git a/a b/a',
    });
  });

  it('rejects callers without a matching run token', async () => {
    expect((await post({ diff: 'x' }, { userId: 'u' })).status).toBe(403);
    expect((await post({ diff: 'x' }, { runId: 7 })).status).toBe(403);
    expect(mocks.screenDiffRiskHints).not.toHaveBeenCalled();
  });

  it('rejects an empty or oversized diff', async () => {
    expect((await post({ diff: '' })).status).toBe(400);
    expect((await post({ diff: 'x'.repeat(400_001) })).status).toBe(400);
  });
});
