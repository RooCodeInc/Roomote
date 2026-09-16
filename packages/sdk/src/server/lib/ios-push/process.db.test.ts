import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { db, eq, userDevices, userFactory } from '@roomote/db/server';

import type { ApnsRequest, ApnsResponse } from './apns';
import { buildIosPushPayload, processIosPushNotificationJob } from './process';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  bundleId: 'dev.roomote.app',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

async function createDevice(
  userId: string,
  overrides: Partial<typeof userDevices.$inferInsert> = {},
) {
  const [device] = await db
    .insert(userDevices)
    .values({
      userId,
      platform: 'ios',
      token: `tok-${crypto.randomUUID()}`,
      environment: 'sandbox',
      bundleId: 'dev.roomote.app',
      ...overrides,
    })
    .returning();
  return device!;
}

function scriptedTransport(responses: ApnsResponse[]) {
  const calls: ApnsRequest[] = [];
  const transport = vi.fn(async (request: ApnsRequest) => {
    calls.push(request);
    return responses.shift() ?? { status: 200, body: '' };
  });
  return { transport, calls };
}

const job = {
  userId: '',
  kind: 'user_input' as const,
  title: 'Deploy fix',
  body: 'Which environment?',
  sessionId: 'session-1',
  fastConversationId: 'conversation-1',
  requestId: 'rui:1',
};

describe('buildIosPushPayload', () => {
  it('matches the documented aps and data shape', () => {
    expect(buildIosPushPayload({ ...job, userId: 'u' })).toEqual({
      aps: {
        alert: { title: 'Deploy fix', body: 'Which environment?' },
        category: 'USER_INPUT',
        'thread-id': 'session-1',
        'mutable-content': 1,
        sound: 'default',
      },
      data: {
        kind: 'user_input',
        sessionId: 'session-1',
        fastConversationId: 'conversation-1',
        taskId: null,
        requestId: 'rui:1',
        url: 'roomote://sessions/session-1',
      },
    });
    expect(
      buildIosPushPayload({
        userId: 'u',
        kind: 'task_settled',
        title: 'T',
        body: 'Completed',
        taskId: 'task-1',
      }),
    ).toMatchObject({
      aps: { category: 'TASK_SETTLED', 'thread-id': 'task-1' },
      data: {
        taskId: 'task-1',
        sessionId: null,
        url: 'roomote://tasks/task-1',
      },
    });
  });
});

describe('processIosPushNotificationJob', () => {
  it('skips quietly when the deployment has no iOS app connection', async () => {
    const user = await userFactory.create();
    await createDevice(user.id);
    const { transport } = scriptedTransport([]);

    await expect(
      processIosPushNotificationJob({ ...job, userId: user.id }, { transport }),
    ).resolves.toBe('not_configured');
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends to every enabled device that opted into the kind', async () => {
    const user = await userFactory.create();
    const wanted = await createDevice(user.id);
    await createDevice(user.id, {
      categories: {
        user_input: false,
        capability_offer: true,
        task_settled: true,
        reply: true,
      },
    });
    await createDevice(user.id, { disabledAt: new Date() });
    const { transport, calls } = scriptedTransport([]);

    await expect(
      processIosPushNotificationJob(
        { ...job, userId: user.id },
        { transport, credentials },
      ),
    ).resolves.toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: 'https://api.sandbox.push.apple.com',
      path: `/3/device/${wanted.token}`,
      headers: { 'apns-topic': 'dev.roomote.app' },
    });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      aps: { category: 'USER_INPUT' },
    });
  });

  it('disables a device Apple reports as unregistered', async () => {
    const user = await userFactory.create();
    const device = await createDevice(user.id);
    const { transport } = scriptedTransport([
      { status: 410, body: '{"reason":"Unregistered"}' },
    ]);

    await expect(
      processIosPushNotificationJob(
        { ...job, userId: user.id },
        { transport, credentials },
      ),
    ).resolves.toBe('failed');
    const [row] = await db
      .select({ disabledAt: userDevices.disabledAt })
      .from(userDevices)
      .where(eq(userDevices.id, device.id));
    expect(row?.disabledAt).toBeInstanceOf(Date);

    await expect(
      processIosPushNotificationJob(
        { ...job, userId: user.id },
        { transport, credentials },
      ),
    ).resolves.toBe('no_devices');
  });

  it('propagates retryable APNs failures so the queue backs off', async () => {
    const user = await userFactory.create();
    await createDevice(user.id);
    const { transport } = scriptedTransport([{ status: 503, body: '' }]);

    await expect(
      processIosPushNotificationJob(
        { ...job, userId: user.id },
        { transport, credentials },
      ),
    ).rejects.toThrow('APNs responded 503');
  });
});
