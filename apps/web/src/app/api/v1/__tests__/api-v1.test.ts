import { NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@/lib/server/auth-context', () => ({ authorize: mocks.authorize }));
vi.mock('@roomote/db/server', () => ({
  db: { select: mocks.select },
  eq: vi.fn(),
  sessions: { id: 'id', fastConversationId: 'fcid' },
}));

import {
  ApiV1Error,
  readJsonBody,
  resolveSessionIds,
  withApiV1Auth,
} from '@/lib/server/api-v1';

const auth = { success: true, userId: 'u1' };

function post(body: unknown) {
  return new NextRequest('https://roomote.test/api/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('withApiV1Auth', () => {
  it('returns 401 as JSON when the session is missing', async () => {
    mocks.authorize.mockResolvedValueOnce({ success: false, error: 'no' });
    const handler = withApiV1Auth(async () => new Response('never'));
    const response = await handler(post({}));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'no' });
  });

  it('passes auth and params to the handler', async () => {
    mocks.authorize.mockResolvedValueOnce(auth);
    const handler = withApiV1Auth<{ id: string }>(async (input) =>
      Response.json({ user: input.auth.userId, id: input.params.id }),
    );
    const response = await handler(post({}), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(await response.json()).toEqual({ user: 'u1', id: 'abc' });
  });

  it('maps tRPC, zod, not-found and ApiV1 errors to statuses', async () => {
    const cases: Array<[unknown, number]> = [
      [new TRPCError({ code: 'CONFLICT', message: 'busy' }), 409],
      [new ApiV1Error('gone', 410), 410],
      [new Error('Fast session not found'), 404],
      [new Error('boom'), 500],
    ];
    for (const [error, status] of cases) {
      mocks.authorize.mockResolvedValueOnce(auth);
      const handler = withApiV1Auth(async () => {
        throw error;
      });
      const response = await handler(post({}));
      expect(response.status).toBe(status);
    }
    mocks.authorize.mockResolvedValueOnce(auth);
    const zodHandler = withApiV1Auth(async ({ request }) => {
      await readJsonBody(request, z.object({ n: z.number() }));
      return Response.json({});
    });
    const bad = await zodHandler(post({ n: 'x' }));
    expect(bad.status).toBe(400);
  });
});

describe('resolveSessionIds', () => {
  function selectReturning(rows: unknown[][]) {
    let call = 0;
    mocks.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => rows[call++] ?? [],
        }),
      }),
    }));
  }

  it('rejects non-uuid ids', async () => {
    await expect(resolveSessionIds('nope')).rejects.toBeInstanceOf(ApiV1Error);
  });

  it('resolves a unified session id to its conversation', async () => {
    selectReturning([[{ id: 's1', fastConversationId: 'c1' }]]);
    await expect(
      resolveSessionIds('e19702ce-306b-4db3-813c-77f299f1eb20'),
    ).resolves.toEqual({ sessionId: 's1', fastConversationId: 'c1' });
  });

  it('accepts a conversation id and finds its session when present', async () => {
    selectReturning([[], [{ id: 's1' }]]);
    await expect(
      resolveSessionIds('e19702ce-306b-4db3-813c-77f299f1eb20'),
    ).resolves.toEqual({
      sessionId: 's1',
      fastConversationId: 'e19702ce-306b-4db3-813c-77f299f1eb20',
    });
  });
});
