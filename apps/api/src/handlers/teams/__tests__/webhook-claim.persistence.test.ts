import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getRedis } from '@roomote/redis';
import {
  db,
  eq,
  runFactory,
  taskRuns,
  tasks,
  teamsInstallations,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveTeamsBotRuntimeCredentials: vi.fn(async () => ({
    botAppId: 'claim-test-bot',
    botAppPassword: null,
    botTenantId: null,
    botTokenEndpoint: null,
    botOauthScope: null,
    source: 'teams_bot',
  })),
}));
vi.mock('../find-active-teams-run', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../find-active-teams-run')>();
  return {
    ...original,
    findActiveTeamsTaskRun: (
      ...args: Parameters<typeof original.findActiveTeamsTaskRun>
    ) => lookup(() => original.findActiveTeamsTaskRun(...args)),
  };
});

import { teams } from '../index';
import { BOT_FRAMEWORK_EXPECTED_ISSUER } from '../bot-framework-auth';

const execFileAsync = promisify(execFile);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Teams webhook claim ownership (Redis and PostgreSQL)', () => {
  const redis = getRedis();
  const fixtures: Array<{
    activityId: string;
    tenantId: string;
    runId: number;
    taskId: string;
  }> = [];
  let authorization: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'claim-test-key',
      endorsements: ['msteams'],
    };
    // Only the external signing-key discovery is disposable. The real verifier
    // checks signature, audience, issuer, service URL and channel endorsement.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (
          String(url) ===
          'https://login.botframework.com/v1/.well-known/openidconfiguration'
        ) {
          return Response.json({
            issuer: BOT_FRAMEWORK_EXPECTED_ISSUER,
            jwks_uri: 'https://claim-test.example/jwks',
          });
        }
        if (String(url) === 'https://claim-test.example/jwks')
          return Response.json({ keys: [jwk] });
        throw new Error(`Unexpected external request: ${url}`);
      }),
    );
    authorization = `Bearer ${await new SignJWT({
      serviceurl: 'https://smba.trafficmanager.net/amer/',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'claim-test-key' })
      .setIssuer(BOT_FRAMEWORK_EXPECTED_ISSUER)
      .setAudience('claim-test-bot')
      .setExpirationTime('1h')
      .sign(privateKey)}`;
  });

  beforeEach(() => {
    lookup.mockReset();
    lookup.mockImplementation((read: () => Promise<unknown>) => read());
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await redis.del(
        `teams:activity:${fixture.activityId}`,
        `teams:messages:${fixture.runId}`,
        `teams:messages:dedupe:${fixture.runId}:${fixture.activityId}`,
      );
      await db.delete(taskRuns).where(eq(taskRuns.id, fixture.runId));
      await db.delete(tasks).where(eq(tasks.id, fixture.taskId));
      await db
        .delete(teamsInstallations)
        .where(eq(teamsInstallations.tenantId, fixture.tenantId));
    }
  });
  afterAll(() => vi.unstubAllGlobals());

  async function createDelivery() {
    const id = randomUUID();
    const activityId = `claim-test-${id}`;
    const tenantId = `claim-test-tenant-${id}`;
    const conversationId = `19:claim-test-${id}@thread.v2`;
    const threadId = `root-${id}`;
    const run = await runFactory.create({
      status: RunStatus.Running,
      payload: {
        repo: 'test/repo',
        description: 'Teams claim fixture',
        communicationProvider: 'teams',
        communicationChannelId: conversationId,
        communicationThreadId: threadId,
      },
    });
    fixtures.push({ activityId, tenantId, runId: run.id, taskId: run.taskId });
    const app = new Hono();
    app.onError(
      () => new Response('Controlled downstream failure', { status: 500 }),
    );
    app.route('/teams', teams);
    const send = () =>
      app.request('/teams', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          id: activityId,
          text: '<at>Roomote</at> continue',
          channelId: 'msteams',
          from: { id: `29:${id}`, name: 'Synthetic operator' },
          recipient: { id: '28:claim-test-bot', name: 'Roomote' },
          conversation: {
            id: conversationId,
            tenantId,
            conversationType: 'channel',
          },
          entities: [
            {
              type: 'mention',
              text: '<at>Roomote</at>',
              mentioned: { id: '28:claim-test-bot', name: 'Roomote' },
            },
          ],
          replyToId: threadId,
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
        }),
      });
    return {
      send,
      key: `teams:activity:${activityId}`,
      runId: run.id,
      tenantId,
    };
  }

  it('does not release a reacquired claim when the expired request fails late', async () => {
    const fixture = await createDelivery();
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    lookup.mockImplementationOnce(() => {
      firstEntered.resolve();
      return firstRead.promise;
    });
    lookup.mockImplementationOnce(async (read: () => Promise<unknown>) => {
      secondEntered.resolve();
      await secondRead.promise;
      return read();
    });
    const first = fixture.send();
    await firstEntered.promise;
    // Accelerate only this owned key's actual expiration; no store flags or
    // fake clock stand in for the Redis expiry/reacquisition boundary.
    await redis.pexpire(fixture.key, 1);
    await vi.waitFor(async () =>
      expect(await redis.exists(fixture.key)).toBe(0),
    );
    const second = fixture.send();
    await secondEntered.promise;
    const owner = await redis.get(fixture.key);
    firstRead.reject(new Error('Delayed lookup failure'));
    try {
      expect((await first).status).toBe(500);
      const third = await fixture.send();
      expect(await third.json()).toEqual({ ok: true, duplicate: true });
      expect(await redis.get(fixture.key)).toBe(owner);
      expect(lookup).toHaveBeenCalledTimes(2);
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          new URL('./webhook-claim.observer.ts', import.meta.url).pathname,
          fixture.key.slice('teams:activity:'.length),
        ],
        { timeout: 15_000 },
      );
      expect(JSON.parse(stdout.trim())).toEqual({ claimed: false });
    } finally {
      secondRead.resolve(undefined);
      expect((await second).status).toBe(200);
    }
  });

  it('releases an ordinary failure and queues the restored delivery exactly once', async () => {
    const fixture = await createDelivery();
    lookup.mockRejectedValueOnce(new Error('Transient lookup failure'));
    expect((await fixture.send()).status).toBe(500);
    expect(await redis.exists(fixture.key)).toBe(0);
    const recovered = await fixture.send();
    expect(await recovered.json()).toEqual({
      ok: true,
      queued: true,
      runId: fixture.runId,
    });
    const owner = await redis.get(fixture.key);
    expect(owner).not.toBeNull();
    expect(await redis.ttl(fixture.key)).toBeGreaterThan(290);
    expect(await redis.llen(`teams:messages:${fixture.runId}`)).toBe(1);
    expect(await (await fixture.send()).json()).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(await redis.get(fixture.key)).toBe(owner);
    expect(await redis.llen(`teams:messages:${fixture.runId}`)).toBe(1);
    const installation = await db.query.teamsInstallations.findFirst({
      where: eq(teamsInstallations.tenantId, fixture.tenantId),
    });
    expect(installation?.isActive).toBe(true);
  });
});
