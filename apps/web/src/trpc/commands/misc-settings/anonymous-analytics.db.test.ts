import { createServer } from 'node:http';
import { db, deploymentSettings, eq } from '@roomote/db/server';
import { ANONYMOUS_ANALYTICS_METADATA_KEY } from '@roomote/feature-flags';
import {
  captureInstanceEvent,
  flushTelemetry,
} from '@roomote/telemetry/server';
import type { UserAuthSuccess } from '@/types';

const mode = vi.hoisted(() => ({ cloud: true, ping: '' }));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();
  return {
    ...actual,
    Env: new Proxy(actual.Env, {
      get(target, key) {
        if (key === 'R_CLOUD_ENABLED') return 'true';
        if (key === 'APP_ENV') return 'development';
        if (key === 'ROOMOTE_FORCE_TELEMETRY') return 'true';
        if (key === 'R_PING_BASE_URL') return mode.ping;
        if (key === 'R_INSTANCE_ID') return 'synthetic_analytics_test';
        return Reflect.get(target, key);
      },
    }),
  };
});

vi.mock('@/lib/server/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/env')>();
  return {
    ...actual,
    Env: new Proxy(actual.Env, {
      get(target, key) {
        if (key === 'R_CLOUD_ENABLED') return mode.cloud ? 'true' : 'false';
        return Reflect.get(target, key);
      },
    }),
  };
});

// Diagnostics may probe storage; persistence and the setting evaluator stay real.
vi.mock('@/lib/server/s3-client', () => ({
  getS3Client: () => ({ send: async () => ({}) }),
}));

import { getMiscSettingsCommand, setAnonymousAnalyticsCommand } from './index';

const admin = { isAdmin: true } as UserAuthSuccess;
let original: typeof deploymentSettings.$inferSelect | undefined;
let received: string[] = [];
const recorder = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  const parsed = JSON.parse(body);
  received.push(
    ...parsed.events.map((event: { event: string }) => event.event),
  );
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end('{"ok":true}');
});

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    recorder.listen(0, '127.0.0.1', resolve),
  );
  const address = recorder.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing recorder address');
  mode.ping = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('R_PING_BASE_URL', mode.ping);
});

afterAll(async () => {
  await new Promise<void>((resolve) => recorder.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  mode.cloud = true;
  received = [];
  original = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
  });
  const metadata = {
    ...(original?.metadata as Record<string, unknown> | null),
    [ANONYMOUS_ANALYTICS_METADATA_KEY]: true,
    analyticsProofSibling: 'preserve',
  };
  await db
    .insert(deploymentSettings)
    .values({ id: 'default', metadata })
    .onConflictDoUpdate({ target: deploymentSettings.id, set: { metadata } });
});

afterEach(async () => {
  if (original) {
    await db
      .update(deploymentSettings)
      .set({ metadata: original.metadata })
      .where(eq(deploymentSettings.id, 'default'));
  } else {
    await db
      .delete(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'));
  }
});

describe('anonymous analytics administrator choice', () => {
  it.each([false, true])(
    'persists opt-out and opt-in with Cloud=%s',
    async (cloud) => {
      mode.cloud = cloud;
      const disabled = await setAnonymousAnalyticsCommand(admin, {
        enabled: false,
      });
      expect(disabled.cloudEnabled).toBe(cloud);
      expect(disabled.anonymousAnalyticsEnabled).toBe(false);
      const stored = await db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
      });
      expect(stored?.metadata).toMatchObject({
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: false,
        analyticsProofSibling: 'preserve',
      });
      expect(
        (await setAnonymousAnalyticsCommand(admin, { enabled: true }))
          .anonymousAnalyticsEnabled,
      ).toBe(true);
    },
  );

  it('keeps the unset Cloud default enabled', async () => {
    await db
      .update(deploymentSettings)
      .set({ metadata: { analyticsProofSibling: 'preserve' } })
      .where(eq(deploymentSettings.id, 'default'));
    expect(
      (await getMiscSettingsCommand(admin)).anonymousAnalyticsEnabled,
    ).toBe(true);
    await captureInstanceEvent('analytics_unset_positive');
    await flushTelemetry();
    expect(received).toEqual(['analytics_unset_positive']);
  });

  it('stops new and already queued server events after Cloud opt-out', async () => {
    await captureInstanceEvent('analytics_enabled_positive');
    await flushTelemetry();
    expect(received).toEqual(['analytics_enabled_positive']);
    received = [];

    await captureInstanceEvent('analytics_queued_before_optout');
    await setAnonymousAnalyticsCommand(admin, { enabled: false });
    await captureInstanceEvent('analytics_after_optout');
    await flushTelemetry();
    expect(received).toEqual([]);
  });

  it('does not permit a member to change deployment consent', async () => {
    await expect(
      setAnonymousAnalyticsCommand({ isAdmin: false } as UserAuthSuccess, {
        enabled: false,
      }),
    ).rejects.toThrow();
    const stored = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
    expect(stored?.metadata).toMatchObject({
      [ANONYMOUS_ANALYTICS_METADATA_KEY]: true,
    });
  });
});
