import { NextRequest } from 'next/server';
import {
  automations,
  customAutomations,
  db,
  eq,
  runFactory,
  taskFactory,
  userFactory,
} from '@roomote/db/server';

const { authorizeUserToken, createResponse } = vi.hoisted(() => ({
  authorizeUserToken: vi.fn(),
  createResponse: vi.fn(async () => new Response('stream')),
}));
vi.mock('@/lib/server', () => ({ authorizeUserToken }));
vi.mock('better-sse', () => ({ createResponse }));

import { GET as getLogs } from './[id]/logs/route';
import { GET as getStream } from './[id]/stream/route';

describe.each([
  ['logs', getLogs],
  ['stream', getStream],
] as const)('%s task access', (_name, get) => {
  it('allows authenticated direct-link reads across automation owners and retains collaborative tasks', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    await db
      .insert(automations)
      .values({ key: 'custom_automation' })
      .onConflictDoNothing();
    const [automation] = await db
      .insert(customAutomations)
      .values({
        name: `Stream ${owner.id}`,
        prompt: 'Private report',
        createdByUserId: owner.id,
      })
      .returning();
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'custom_automation',
      actorExternalId: automation!.id,
    });
    const run = await runFactory.create({ taskId: task.id });
    const request = new NextRequest('http://localhost/api/task-runs/1/stream');
    const params = { params: Promise.resolve({ id: String(run.id) }) };
    for (const [userId, isAdmin, status] of [
      [other.id, false, 200],
      [owner.id, false, 200],
      [other.id, true, 200],
    ] as const) {
      createResponse.mockClear();
      authorizeUserToken.mockResolvedValue({ success: true, userId, isAdmin });
      expect((await get(request, params)).status).toBe(status);
      expect(createResponse).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    }
    await db
      .delete(customAutomations)
      .where(eq(customAutomations.id, automation!.id));
    authorizeUserToken.mockResolvedValue({
      success: true,
      userId: owner.id,
      isAdmin: false,
    });
    expect((await get(request, params)).status).toBe(200);
    const ordinary = await taskFactory.create({ initiatorUserId: other.id });
    const ordinaryRun = await runFactory.create({ taskId: ordinary.id });
    expect(
      (
        await get(request, {
          params: Promise.resolve({ id: String(ordinaryRun.id) }),
        })
      ).status,
    ).toBe(200);
  });

  it('rejects anonymous requests before starting a stream', async () => {
    createResponse.mockClear();
    authorizeUserToken.mockResolvedValue({ success: false });
    const response = await get(
      new NextRequest('http://localhost/api/task-runs/1/stream'),
      { params: Promise.resolve({ id: '1' }) },
    );
    expect(response.status).toBe(401);
    expect(createResponse).not.toHaveBeenCalled();
  });
});
