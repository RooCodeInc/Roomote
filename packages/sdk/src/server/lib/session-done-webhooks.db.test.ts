import { createHmac } from 'node:crypto';

import {
  db,
  deploymentSettings,
  eq,
  sessionDoneWebhookDeliveries,
  sessionFactory,
  sessionStatusJudgments,
  sessionTasks,
  sessions,
  taskFactory,
  tasks,
} from '@roomote/db/server';

import { drainSessionDoneWebhookDeliveries } from './session-done-webhooks';
import { safeFetch } from './safe-fetch';

const sessionIds: string[] = [];
const taskIds: string[] = [];

afterEach(async () => {
  while (sessionIds.length > 0) {
    await db.delete(sessions).where(eq(sessions.id, sessionIds.pop()!));
  }
  while (taskIds.length > 0) {
    await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
  }
  await db
    .update(deploymentSettings)
    .set({
      sessionDoneWebhookEnabled: false,
      sessionDoneWebhookUrl: null,
      sessionDoneWebhookSecret: null,
    })
    .where(eq(deploymentSettings.id, 'default'));
});

describe('Session done webhook delivery', () => {
  it('sends a signed metadata-only event and marks it delivered', async () => {
    const secret = 'a-test-signing-secret';
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        sessionDoneWebhookEnabled: true,
        sessionDoneWebhookUrl: 'https://orchestrator.example/roomote',
        sessionDoneWebhookSecret: secret,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          sessionDoneWebhookEnabled: true,
          sessionDoneWebhookUrl: 'https://orchestrator.example/roomote',
          sessionDoneWebhookSecret: secret,
        },
      });
    const session = await sessionFactory.create({ title: 'Private details' });
    sessionIds.push(session.id);
    const task = await taskFactory.create({ state: 'completed' });
    taskIds.push(task.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    const [judgment] = await db
      .insert(sessionStatusJudgments)
      .values({
        sessionId: session.id,
        sourceEventId: 'turn-1',
        generation: 1,
        sourceKind: 'fast_turn',
        state: 'applied',
        outcome: 'done',
        judgedAt: new Date('2026-10-04T12:34:56.000Z'),
      })
      .returning();
    const [delivery] = await db
      .insert(sessionDoneWebhookDeliveries)
      .values({ sessionId: session.id, judgmentId: judgment!.id })
      .returning();
    const now = new Date('2030-10-04T12:35:00.000Z');
    const fetch = vi.fn<typeof safeFetch>(async () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    await expect(
      drainSessionDoneWebhookDeliveries({ fetch, now: () => now }),
    ).resolves.toEqual({ delivered: 1, failed: 0, skipped: 0 });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://orchestrator.example/roomote');
    const body = options?.body as string;
    expect(JSON.parse(body)).toMatchObject({
      id: delivery!.id,
      type: 'session.done',
      version: 1,
      session: { id: session.id },
      status: {
        value: 'done',
        source: 'decision_model',
        judgmentId: judgment!.id,
      },
      tasks: [{ id: task.id, state: 'completed' }],
    });
    expect(body).not.toContain('Private details');
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    expect(options?.headers).toMatchObject({
      'x-roomote-delivery': delivery!.id,
      'x-roomote-event': 'session.done',
      'x-roomote-timestamp': timestamp,
      'x-roomote-signature-256': `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex')}`,
    });

    const stored = await db.query.sessionDoneWebhookDeliveries.findFirst({
      where: eq(sessionDoneWebhookDeliveries.id, delivery!.id),
    });
    expect(stored).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(stored?.deliveredAt).toEqual(now);
  });
});
