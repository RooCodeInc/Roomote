import { TaskPayloadKind } from '@roomote/types';
import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const mocks = vi.hoisted(() => ({
  enqueueUpdate: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueUserPersonalizationUpdate: mocks.enqueueUpdate,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: mocks.limit })),
        })),
      })),
    })),
  },
  eq: vi.fn(),
  taskRuns: {
    actingUserId: 'actingUserId',
    id: 'id',
    payloadKind: 'payloadKind',
    taskId: 'taskId',
  },
  tasks: { id: 'id', initiatorKind: 'initiatorKind' },
}));

import {
  canLearnPersonalizationForRun,
  updatePersonalization,
} from '../updatePersonalization';

function createApp() {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', {
      userId: undefined,
      authContext: { runId: 42 } as never,
    });
    await next();
  });
  app.post('/tasks/runs/:runId/personalization', updatePersonalization);
  return app;
}

function postUpdate(app: ReturnType<typeof createApp>) {
  return app.request('/tasks/runs/42/personalization', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preference: 'Be concise.',
      confidence: 'explicit',
    }),
  });
}

describe('personalization learning run authorization', () => {
  it.each([
    TaskPayloadKind.StandardTask,
    TaskPayloadKind.SlackAppMention,
    TaskPayloadKind.LinearAgentSession,
    TaskPayloadKind.SnapshotResume,
    TaskPayloadKind.GithubPrReview,
  ])('allows a trusted user actor on %s', (payloadKind) => {
    expect(
      canLearnPersonalizationForRun({
        actingUserId: 'current-user',
        initiatorKind: 'user',
        payloadKind,
      }),
    ).toBe(true);
  });

  it.each([
    {
      actingUserId: 'service-user',
      initiatorKind: 'automation',
      payloadKind: TaskPayloadKind.StandardTask,
    },
    {
      actingUserId: 'user-1',
      initiatorKind: 'user',
      payloadKind: TaskPayloadKind.Scan,
    },
    {
      actingUserId: null,
      initiatorKind: 'user',
      payloadKind: TaskPayloadKind.SnapshotResume,
    },
  ])('denies automation, maintenance, and actorless runs', (run) => {
    expect(canLearnPersonalizationForRun(run)).toBe(false);
  });
});

describe('updatePersonalization', () => {
  beforeEach(() => {
    mocks.enqueueUpdate.mockReset();
    mocks.limit.mockReset();
    mocks.limit.mockResolvedValue([
      {
        actingUserId: 'user-1',
        initiatorKind: 'user',
        payloadKind: TaskPayloadKind.StandardTask,
      },
    ]);
  });

  it('returns success only after persistence succeeds', async () => {
    mocks.enqueueUpdate.mockResolvedValue({ saved: true });

    const response = await postUpdate(createApp());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ saved: true });
    expect(mocks.enqueueUpdate).toHaveBeenCalledWith({
      userId: 'user-1',
      preference: 'Be concise.',
      confidence: 'explicit',
      taskId: '42',
    });
  });

  it('returns the opt-out result without confirming a save', async () => {
    mocks.enqueueUpdate.mockResolvedValue({
      saved: false,
      reason: 'disabled',
    });

    const response = await postUpdate(createApp());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      saved: false,
      reason: 'disabled',
    });
  });

  it('returns an error when persistence fails', async () => {
    mocks.enqueueUpdate.mockRejectedValue(new Error('db unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await postUpdate(createApp());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to update personalization',
    });
    errorSpy.mockRestore();
  });
});
