import { TASK_MEMORY_LIMITS } from '@roomote/types';
import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const mocks = vi.hoisted(() => ({
  isBrainEnabled: vi.fn(),
  isTaskRunSharedBrainEligible: vi.fn(),
  saveBrainAgentSummary: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  isBrainEnabled: mocks.isBrainEnabled,
  isTaskRunSharedBrainEligible: mocks.isTaskRunSharedBrainEligible,
  saveBrainAgentSummary: mocks.saveBrainAgentSummary,
}));

import { saveTaskMemory } from '../saveTaskMemory';

function createApp() {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId: undefined,
      authContext: { runId: 42 } as never,
    });
    await next();
  });
  app.post('/tasks/runs/:runId/memory', saveTaskMemory);
  return app;
}

function postMemory(body: unknown) {
  return createApp().request('/tasks/runs/42/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('saveTaskMemory', () => {
  beforeEach(() => {
    mocks.isBrainEnabled.mockReset().mockResolvedValue(true);
    mocks.isTaskRunSharedBrainEligible.mockReset().mockResolvedValue(true);
    mocks.saveBrainAgentSummary.mockReset().mockResolvedValue(undefined);
  });

  it('keeps private task memories out of the shared Brain', async () => {
    mocks.isTaskRunSharedBrainEligible.mockResolvedValue(false);

    const response = await postMemory({ outcome: 'Private work completed.' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      saved: false,
      reason: 'Private tasks cannot write shared memory.',
    });
    expect(mocks.saveBrainAgentSummary).not.toHaveBeenCalled();
  });

  it('saves a memory within the caps', async () => {
    const response = await postMemory({
      outcome: 'Fixed the flaky checkout test.',
      reusableFacts: ['The cart total updates asynchronously.'],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ saved: true });
    expect(mocks.saveBrainAgentSummary).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.stringContaining('## Reusable facts'),
    );
  });

  it('names the field and the cap when the outcome is too long', async () => {
    const outcome = 'x'.repeat(TASK_MEMORY_LIMITS.outcomeMaxChars + 1_153);

    const response = await postMemory({ outcome });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      `Invalid task memory: outcome: at most ${TASK_MEMORY_LIMITS.outcomeMaxChars} characters (got ${outcome.length} characters)`,
    );
    expect(mocks.saveBrainAgentSummary).not.toHaveBeenCalled();
  });

  it('names the entry and the list cap for oversized list fields', async () => {
    const response = await postMemory({
      outcome: 'ok',
      reusableFacts: [
        'short',
        'y'.repeat(TASK_MEMORY_LIMITS.listEntryMaxChars + 1),
      ],
      decisions: Array.from(
        { length: TASK_MEMORY_LIMITS.listMaxEntries + 1 },
        () => 'd',
      ),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      [
        'Invalid task memory: ',
        `decisions: at most ${TASK_MEMORY_LIMITS.listMaxEntries} entries (got ${TASK_MEMORY_LIMITS.listMaxEntries + 1} entries); `,
        `reusableFacts.1: at most ${TASK_MEMORY_LIMITS.listEntryMaxChars} characters (got ${TASK_MEMORY_LIMITS.listEntryMaxChars + 1} characters)`,
      ].join(''),
    );
  });
});
