import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { DesktopDeviceAuditEvent } from '@roomote/types';

import {
  DesktopDeviceBroker,
  DesktopBrokerError,
  assertDesktopMcpContext,
  type DesktopDeviceBrokerOptions,
  type DesktopDeviceStore,
} from './broker';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

describe('DesktopDeviceBroker', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('requires the canonical Roomote MCP audience and scope', () => {
    const context = {
      userId: 'owner-a',
      tokenType: 'mcp' as const,
      version: 1 as const,
      resource: 'https://roomote.example/mcp',
      scopes: ['mcp:roomote' as const],
    };
    expect(() =>
      assertDesktopMcpContext(context, 'https://roomote.example/mcp'),
    ).not.toThrow();
    expect(() =>
      assertDesktopMcpContext(context, 'https://other.example/mcp'),
    ).toThrowError(DesktopBrokerError);
    expect(() =>
      assertDesktopMcpContext(
        { ...context, scopes: [] },
        'https://roomote.example/mcp',
      ),
    ).toThrowError(DesktopBrokerError);
  });

  it('registers an owner-bound device and forwards first-class image results', async () => {
    const fixture = await createFixture();
    const client = await connectClient(fixture.url, 'owner-a');
    client.send(JSON.stringify(hello()));
    await waitFor(() => fixture.devices.has(DEVICE_ID));

    const requestPromise = fixture.broker.request('owner-a', DEVICE_ID, {
      action: 'capture',
      displayId: 1,
    });
    const [requestFrame] = (await once(client, 'message')) as [Buffer];
    const request = JSON.parse(requestFrame.toString()) as { id: string };
    client.send(
      JSON.stringify({
        type: 'response',
        id: request.id,
        result: {
          content: [
            { type: 'text', text: '{"width":1}' },
            { type: 'image', data: 'cG5n', mimeType: 'image/png' },
          ],
          structuredContent: { width: 1, height: 1 },
        },
      }),
    );

    await expect(requestPromise).resolves.toMatchObject({
      content: [
        { type: 'text' },
        { type: 'image', data: 'cG5n', mimeType: 'image/png' },
      ],
    });
    await expect(
      fixture.broker.request('owner-b', DEVICE_ID, { action: 'status' }),
    ).rejects.toMatchObject({ code: 'device_offline' });
    expect(fixture.audit.map((event) => event.event)).toContain('connected');
    expect(fixture.audit.map((event) => event.event)).toContain('request');
  });

  it('rejects unauthenticated upgrades and malformed hello messages', async () => {
    const denied = await createFixture(async () => {
      throw new DesktopBrokerError('unauthorized', 'denied');
    });
    const rejected = new WebSocket(denied.url);
    const [, response] = (await once(rejected, 'unexpected-response')) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(401);
    rejected.on('error', () => undefined);
    rejected.terminate();

    const fixture = await createFixture();
    const client = await connectClient(fixture.url, 'owner-a');
    client.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        device: { name: 'Missing ID', platform: 'darwin' },
        capabilities: ['status'],
      }),
    );
    const [code] = (await once(client, 'close')) as [number];
    expect(code).toBe(1008);
    expect(fixture.devices.size).toBe(0);
    await waitFor(() =>
      fixture.audit.some((event) => event.event === 'rejected'),
    );
  });

  it('revalidates revocation before returning a response', async () => {
    const fixture = await createFixture();
    const client = await connectClient(fixture.url, 'owner-a');
    client.send(JSON.stringify(hello()));
    await waitFor(() => fixture.devices.has(DEVICE_ID));

    const requestPromise = fixture.broker.request('owner-a', DEVICE_ID, {
      action: 'status',
    });
    const requestRejection =
      expect(requestPromise).rejects.toBeInstanceOf(DesktopBrokerError);
    const [requestFrame] = (await once(client, 'message')) as [Buffer];
    const request = JSON.parse(requestFrame.toString()) as { id: string };
    fixture.devices.get(DEVICE_ID)!.active = false;
    client.send(
      JSON.stringify({
        type: 'response',
        id: request.id,
        result: {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {},
        },
      }),
    );

    const [revokeFrame] = (await once(client, 'message')) as [Buffer];
    expect(JSON.parse(revokeFrame.toString())).toEqual({ type: 'revoke' });
    await requestRejection;
    const [code] = (await once(client, 'close')) as [number];
    expect(code).toBe(1000);
  });

  it('delivers revoke and closes the live connection', async () => {
    const fixture = await createFixture();
    const client = await connectClient(fixture.url, 'owner-a');
    client.send(JSON.stringify(hello()));
    await waitFor(() => fixture.devices.has(DEVICE_ID));
    const message = once(client, 'message');
    expect(fixture.broker.revoke('owner-a', DEVICE_ID)).toBe(true);
    const [frame] = (await message) as [Buffer];
    expect(JSON.parse(frame.toString())).toEqual({ type: 'revoke' });
    await once(client, 'close');
  });

  it('does not mark a replacement connection disconnected when the old socket closes', async () => {
    const fixture = await createFixture();
    const first = await connectClient(fixture.url, 'owner-a');
    first.send(JSON.stringify(hello()));
    await waitFor(() => fixture.devices.has(DEVICE_ID));
    const firstClosed = once(first, 'close');

    const replacement = await connectClient(fixture.url, 'owner-a');
    replacement.send(JSON.stringify(hello()));
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.broker.isOnline('owner-a', DEVICE_ID)).toBe(true);
    expect(fixture.disconnects).toEqual([]);
  });

  it('allows one request at a time and rejects unsafe local-path metadata', async () => {
    const fixture = await createFixture();
    const client = await connectClient(fixture.url, 'owner-a');
    client.send(JSON.stringify(hello()));
    await waitFor(() => fixture.devices.has(DEVICE_ID));

    const first = fixture.broker.request('owner-a', DEVICE_ID, {
      action: 'status',
    });
    await expect(
      fixture.broker.request('owner-a', DEVICE_ID, { action: 'status' }),
    ).rejects.toMatchObject({ code: 'device_busy' });
    const [requestFrame] = (await once(client, 'message')) as [Buffer];
    const request = JSON.parse(requestFrame.toString()) as { id: string };
    client.send(
      JSON.stringify({
        type: 'response',
        id: request.id,
        result: {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { output: '/tmp/private.png' },
        },
      }),
    );
    await expect(first).rejects.toMatchObject({ code: 'unsafe_response' });
  });

  async function createFixture(
    authenticate: DesktopDeviceBrokerOptions['authenticate'] = async (
      request,
    ) => ({
      userId: request.headers.authorization?.replace('Bearer ', '') ?? '',
      expiresAt: Date.now() + 60_000,
    }),
  ) {
    const devices = new Map<string, { ownerUserId: string; active: boolean }>();
    const audit: Array<{ event: DesktopDeviceAuditEvent }> = [];
    const disconnects: string[] = [];
    const store: DesktopDeviceStore = {
      register: async (input) => {
        const existing = devices.get(input.id);
        if (existing && existing.ownerUserId !== input.ownerUserId)
          return 'owner_mismatch';
        if (existing && !existing.active) return 'revoked';
        devices.set(input.id, { ownerUserId: input.ownerUserId, active: true });
        return 'connected';
      },
      getActive: async (ownerUserId, deviceId) => {
        const device = devices.get(deviceId);
        return device?.ownerUserId === ownerUserId && device.active
          ? ({ id: deviceId } as Awaited<
              ReturnType<DesktopDeviceStore['getActive']>
            >)
          : undefined;
      },
      disconnected: async (_ownerUserId, deviceId) => {
        disconnects.push(deviceId);
      },
      audit: async (input) => {
        audit.push({ event: input.event });
      },
    };
    const broker = new DesktopDeviceBroker({
      instanceId: 'test-api',
      authenticate,
      store,
    });
    const server = createServer();
    broker.install(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    cleanups.push(() => {
      broker.closeAll();
      server.close();
    });
    return {
      broker,
      devices,
      audit,
      disconnects,
      url: `ws://127.0.0.1:${address.port}/api/desktop/devices/connect`,
    };
  }
});

async function connectClient(url: string, owner: string): Promise<WebSocket> {
  const client = new WebSocket(url, {
    headers: { Authorization: `Bearer ${owner}` },
  });
  await once(client, 'open');
  return client;
}

function hello() {
  return {
    type: 'hello',
    protocolVersion: 1,
    device: { id: DEVICE_ID, name: 'Test Mac', platform: 'darwin' },
    capabilities: ['capture', 'status', 'stop', 'disarm'],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}
