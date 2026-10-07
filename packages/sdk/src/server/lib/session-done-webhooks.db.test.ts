import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

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
  it.each([200, 400, 503])(
    'preserves HTTP %s when the receiver drops its unused response body',
    async (status) => {
      let requests = 0;
      let recovered = false;
      const deliveryIds: string[] = [];
      const server = createServer((request, response) => {
        requests += 1;
        deliveryIds.push(String(request.headers['x-roomote-delivery']));
        request.resume();
        request.on('end', () => {
          if (recovered) {
            response.writeHead(204);
            response.end();
            return;
          }
          response.writeHead(status, { 'content-length': '100' });
          response.flushHeaders();
          // A receiver can acknowledge the event and then lose its connection.
          setTimeout(() => response.destroy(), 10);
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const url = `http://127.0.0.1:${address.port}/roomote`;
      try {
        await db
          .insert(deploymentSettings)
          .values({
            id: 'default',
            sessionDoneWebhookEnabled: true,
            sessionDoneWebhookUrl: url,
            sessionDoneWebhookSecret: 'test-secret',
          })
          .onConflictDoUpdate({
            target: deploymentSettings.id,
            set: {
              sessionDoneWebhookEnabled: true,
              sessionDoneWebhookUrl: url,
              sessionDoneWebhookSecret: 'test-secret',
            },
          });
        const session = await sessionFactory.create();
        sessionIds.push(session.id);
        const [judgment] = await db
          .insert(sessionStatusJudgments)
          .values({
            sessionId: session.id,
            sourceEventId: `body-disconnect-${status}`,
            generation: 1,
            sourceKind: 'fast_turn',
            state: 'applied',
            outcome: 'done',
          })
          .returning();
        const [delivery] = await db
          .insert(sessionDoneWebhookDeliveries)
          .values({ sessionId: session.id, judgmentId: judgment!.id })
          .returning();
        const now = new Date('2030-10-04T12:35:00.000Z');
        const fetch: typeof safeFetch = async (target, options) => {
          const response = await safeFetch(target, options);
          if (recovered) return response;
          // Control ordering: let the real network disconnect reach the stream
          // before the drain discards it. No status or stream is fabricated.
          const reader = response.body!.getReader();
          await expect(reader.closed).rejects.toThrow();
          reader.releaseLock();
          return response;
        };
        await drainSessionDoneWebhookDeliveries({
          fetch,
          now: () => now,
          allowedPrivateCidrs: '127.0.0.1/32',
        });
        const stored = await db.query.sessionDoneWebhookDeliveries.findFirst({
          where: eq(sessionDoneWebhookDeliveries.id, delivery!.id),
        });
        expect(stored).toMatchObject({
          status:
            status === 200
              ? 'delivered'
              : status === 400
                ? 'failed'
                : 'pending',
          attempts: 1,
          lastError:
            status === 200 ? null : `Webhook endpoint returned HTTP ${status}.`,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        expect(requests).toBe(1);
        if (status === 503) {
          expect(stored?.nextAttemptAt).toEqual(
            new Date(now.getTime() + 60_000),
          );
        }
        recovered = true;
        await expect(
          drainSessionDoneWebhookDeliveries({
            fetch,
            now: () => now,
            allowedPrivateCidrs: '127.0.0.1/32',
          }),
        ).resolves.toEqual({ delivered: 0, failed: 0, skipped: 0 });
        expect(requests).toBe(1);
        await expect(
          drainSessionDoneWebhookDeliveries({
            fetch,
            now: () => new Date(now.getTime() + 60_000),
            allowedPrivateCidrs: '127.0.0.1/32',
          }),
        ).resolves.toEqual({
          delivered: status === 503 ? 1 : 0,
          failed: 0,
          skipped: 0,
        });
        expect(deliveryIds).toEqual(
          status === 503 ? [delivery!.id, delivery!.id] : [delivery!.id],
        );
        const final = await db.query.sessionDoneWebhookDeliveries.findFirst({
          where: eq(sessionDoneWebhookDeliveries.id, delivery!.id),
        });
        expect(final).toMatchObject({
          status: status === 400 ? 'failed' : 'delivered',
          attempts: status === 503 ? 2 : 1,
          leaseToken: null,
          leaseExpiresAt: null,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('sends a signed metadata-only event and marks it delivered', async () => {
    const secret = 'a-test-signing-secret';
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        sessionDoneWebhookEnabled: true,
        sessionDoneWebhookUrl: 'http://127.0.0.1:4317/roomote',
        sessionDoneWebhookSecret: secret,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          sessionDoneWebhookEnabled: true,
          sessionDoneWebhookUrl: 'http://127.0.0.1:4317/roomote',
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
      drainSessionDoneWebhookDeliveries({
        fetch,
        now: () => now,
        allowedPrivateCidrs: '127.0.0.1/32',
      }),
    ).resolves.toEqual({ delivered: 1, failed: 0, skipped: 0 });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4317/roomote');
    expect(options?.allowedPrivateCidrs).toBe('127.0.0.1/32');
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
