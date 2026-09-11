import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  configureAuthClientEnv,
  createAuthToken,
  createRunToken,
  createSessionBrokerToken,
  createSessionEgressControllerToken,
} from '@roomote/auth';
import {
  db,
  eq,
  inArray,
  or,
  sql,
  users,
  sessions,
  tasks,
  taskRuns,
  sessionTasks,
  sessionSecrets,
  sessionSecretAudit,
  sessionEgressAudit,
  sessionEgressRevocations,
  sessionEgressWorkloads,
  fastAgentConversations,
  userFactory,
  sessionFactory,
  taskFactory,
  runFactory,
  hashSessionEgressSubstitute,
  type SessionSecretContext,
} from '@roomote/db/server';
import {
  createSessionSecret,
  prepareSessionSecret,
  revokeSessionSecret,
} from '@roomote/sdk/server/session-secrets';
import { createSessionEgressControllerClient } from '@roomote/sdk/server/session-egress';
import {
  RunStatus,
  SESSION_EGRESS_CONTROL_PLANE_PATH,
  SESSION_EGRESS_SUBSTITUTE_PREFIX,
  type SessionEgressAuthorization,
  type SessionEgressAuthorize,
  type SessionEgressWorkloadRegistration,
} from '@roomote/types';
import { routePolicyMiddleware } from '../../../middleware/routePolicyMiddleware';
import { tokenAuthMiddleware } from '../../../middleware/tokenAuthMiddleware';
import { findRoutePolicyRule } from '../../../route-policies';
import type { Variables } from '../../../types';
import { integrationRequest } from '../../mcp/http-integrations/broker';
import { createSessionEgressControlPlane } from '../index';

const GATEWAY = 'test-gateway-shared-secret-that-is-long-enough-0123456789';
const secret = 'Real-Upstream-Key/A+b=<"&>123';
const origin = 'https://api.example.com';
const path = SESSION_EGRESS_CONTROL_PLANE_PATH;

let app: Hono<{ Variables: Variables }>;
let ownerId: string;
let otherId: string;
let context: SessionSecretContext;
let sessionId: string;
let runId: number;
let taskId: string;
let secretRef: string;
let userIds: string[];
let sessionIds: string[];
let taskIds: string[];
const minted: string[] = [];
const consoleOutput: string[] = [];

function connector() {
  return `spiffe://roomote/connector/${randomBytes(12).toString('hex')}`;
}

async function session(userId: string) {
  const [fast] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
    })
    .returning();
  const row = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId: userId,
    fastConversationId: fast!.id,
  });
  sessionIds.push(row.id);
  return row;
}

async function run(userId: string | null, attachTo?: string) {
  const task = await taskFactory.create({ initiatorUserId: ownerId });
  taskIds.push(task.id);
  const row = await runFactory.create({
    taskId: task.id,
    actingUserId: userId,
    status: RunStatus.Running,
  });
  if (attachTo)
    await db.insert(sessionTasks).values({
      sessionId: attachTo,
      taskId: task.id,
      origin: 'direct_launch',
    });
  return row;
}

async function call(
  route: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
) {
  const response = await app.request(`${path}${route}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.token === null
        ? {}
        : { authorization: `Bearer ${init.token ?? GATEWAY}` }),
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined
      ? {}
      : {
          body:
            typeof init.body === 'string'
              ? init.body
              : JSON.stringify(init.body),
        }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function register(
  input: { runId?: number; connectorIdentity?: string; provider?: string } = {},
) {
  const result = await call('/workloads', {
    token: await createSessionEgressControllerToken(),
    body: {
      runId: input.runId ?? runId,
      provider: input.provider ?? 'docker',
      connectorIdentity: input.connectorIdentity ?? connector(),
    },
  });
  if (result.status === 201)
    for (const issue of (result.json as SessionEgressWorkloadRegistration)
      .substitutes)
      minted.push(issue.substitute);
  return result;
}

async function registered() {
  const result = await register();
  expect(result.status).toBe(201);
  const registration = result.json as SessionEgressWorkloadRegistration;
  const [issue] = registration.substitutes;
  return {
    registration,
    connectorIdentity: (
      await db.execute<{ connector_identity: string }>(
        sql`select connector_identity from session_egress_workloads where id = ${registration.workloadId}`,
      )
    )[0]!.connector_identity,
    substitute: issue!.substitute,
  };
}

function authorizeBody(
  base: {
    registration: SessionEgressWorkloadRegistration;
    connectorIdentity: string;
    substitute: string;
  },
  overrides: Partial<SessionEgressAuthorize> = {},
): SessionEgressAuthorize {
  return {
    workloadId: base.registration.workloadId,
    connectorIdentity: base.connectorIdentity,
    substitute: base.substitute,
    destination: { host: 'api.example.com', port: 443 },
    method: 'GET',
    path: '/v1/items?token=private-query-marker',
    phase: 'request',
    ...overrides,
  };
}

async function authorize(body: unknown, token = GATEWAY) {
  const result = await call('/authorize', { token, body });
  expect(result.status).toBe(200);
  return result.json as SessionEgressAuthorization;
}

async function tableDump() {
  const rows = await Promise.all(
    [
      'session_egress_workloads',
      'session_egress_substitutes',
      'session_egress_audit',
      'session_egress_revocations',
      'session_secrets',
      'session_secret_approvals',
    ].map((table) => db.execute(sql.raw(`select * from ${table}`))),
  );
  return JSON.stringify(rows);
}

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  configureAuthClientEnv({
    jobAuthPrivateKey: privateKey,
    jobAuthPublicKey: publicKey,
  });
});

afterAll(() => configureAuthClientEnv(null));

beforeEach(async () => {
  consoleOutput.length = 0;
  for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => String(arg)).join(' '));
    });
  app = new Hono<{ Variables: Variables }>();
  app.use('*', tokenAuthMiddleware());
  app.use('*', routePolicyMiddleware);
  app.route(
    path,
    createSessionEgressControlPlane({ gatewayToken: () => GATEWAY }),
  );
  userIds = [];
  sessionIds = [];
  taskIds = [];
  minted.length = 0;
  for (let i = 0; i < 2; i++) userIds.push((await userFactory.create()).id);
  [ownerId, otherId] = userIds as [string, string];
  const row = await session(ownerId);
  sessionId = row.id;
  context = { userId: ownerId, sessionId };
  const attached = await run(ownerId, sessionId);
  runId = attached.id;
  taskId = attached.taskId;
  const pending = await prepareSessionSecret(context, {
    label: 'Example API',
    origin,
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
  });
  ({ secretRef } = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret,
  }));
});

afterEach(async () => {
  const output = consoleOutput.join('\n');
  expect(output).not.toContain(secret);
  for (const token of minted) expect(output).not.toContain(token);
  vi.restoreAllMocks();
  const ownWorkloads = db
    .select({ id: sessionEgressWorkloads.id })
    .from(sessionEgressWorkloads)
    .where(inArray(sessionEgressWorkloads.sessionId, sessionIds));
  const ownSecrets = db
    .select({ id: sessionSecrets.id })
    .from(sessionSecrets)
    .where(inArray(sessionSecrets.sessionId, sessionIds));
  await db
    .delete(sessionEgressAudit)
    .where(inArray(sessionEgressAudit.workloadId, ownWorkloads));
  await db
    .delete(sessionEgressRevocations)
    .where(
      or(
        inArray(sessionEgressRevocations.workloadId, ownWorkloads),
        inArray(sessionEgressRevocations.secretRef, ownSecrets),
      ),
    );
  await db
    .delete(sessionSecretAudit)
    .where(inArray(sessionSecretAudit.secretRef, ownSecrets));
  await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  await db.delete(tasks).where(inArray(tasks.id, taskIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

it('is classified as a handler-authenticated internal surface', () => {
  expect(findRoutePolicyRule(`${path}/authorize`)).toMatchObject({
    name: 'internal-session-egress',
    policy: 'webhook',
  });
});

it('is absent until a gateway secret is configured', async () => {
  app = new Hono<{ Variables: Variables }>();
  app.route(
    path,
    createSessionEgressControlPlane({ gatewayToken: () => null }),
  );
  expect((await call('/workloads', { body: {} })).status).toBe(404);
  expect((await call('/authorize', { body: {} })).status).toBe(404);
});

it('accepts only the controller and gateway service principals on their own routes', async () => {
  const runToken = await createRunToken({
    runId,
    userId: ownerId,
    timeoutMs: 60_000,
  });
  const userToken = await createAuthToken({
    userId: ownerId,
    timeoutMs: 60_000,
  });
  const brokerToken = await createSessionBrokerToken({
    userId: ownerId,
    fastConversationId: (await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    }))!.fastConversationId!,
  });
  const body = { runId, provider: 'docker', connectorIdentity: connector() };
  for (const token of [
    null,
    runToken,
    userToken,
    brokerToken,
    `${GATEWAY}x`,
    GATEWAY.slice(1),
  ]) {
    expect((await call('/workloads', { token, body })).status).toBe(401);
    expect((await call('/authorize', { token, body: {} })).status).toBe(401);
    expect((await call('/revocations', { method: 'GET', token })).status).toBe(
      401,
    );
  }
  // The gateway may not register workloads; the controller may not resolve credentials.
  expect((await call('/workloads', { token: GATEWAY, body })).status).toBe(403);
  const controller = await createSessionEgressControllerToken();
  expect(
    (await call('/authorize', { token: controller, body: {} })).status,
  ).toBe(403);
  expect(
    (await call('/revocations', { method: 'GET', token: controller })).status,
  ).toBe(403);
  const dump = await tableDump();
  expect(dump).not.toContain('session_egress_workloads_placeholder');
  expect(
    (
      await db.execute(
        sql`select count(*)::int as n from session_egress_workloads where session_id = ${sessionId}`,
      )
    )[0],
  ).toEqual({ n: 0 });
});

it('registers an attached run, returns substitutes once, and stores only a keyed hash', async () => {
  const { registration, substitute } = await registered();
  expect(registration).toMatchObject({
    sessionId,
    generation: 1,
    substitutes: [
      {
        secretRef,
        label: 'Example API',
        origin,
        headerName: 'authorization',
        headerPrefix: 'Bearer ',
        allowedMethods: ['GET', 'HEAD'],
      },
    ],
  });
  expect(substitute.startsWith(SESSION_EGRESS_SUBSTITUTE_PREFIX)).toBe(true);
  expect(JSON.stringify(registration)).not.toContain(secret);
  expect(JSON.stringify(registration)).not.toContain('value');
  const [row] = await db.execute<{ token_hash: string; generation: number }>(
    sql`select token_hash, generation from session_egress_substitutes where workload_id = ${registration.workloadId}`,
  );
  expect(row).toEqual({
    token_hash: hashSessionEgressSubstitute(substitute),
    generation: 1,
  });
  const dump = await tableDump();
  expect(dump).not.toContain(substitute);
  expect(dump).not.toContain(
    substitute.slice(SESSION_EGRESS_SUBSTITUTE_PREFIX.length),
  );
  expect(dump).not.toContain(secret);
});

it('authorizes each phase live and resolves the credential only on the request phase', async () => {
  const base = await registered();
  const request = await authorize(authorizeBody(base));
  expect(request).toMatchObject({
    allowed: true,
    workloadId: base.registration.workloadId,
    generation: 1,
    sessionId,
    secretRef,
    credential: {
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
      value: secret,
    },
  });
  const authorizationId = (request as { authorizationId: string })
    .authorizationId;
  // A 24h grant is capped by the one-hour default lease.
  expect((request as { expiresAt: string }).expiresAt).toBe(
    base.registration.expiresAt,
  );
  for (const phase of ['response', 'stream'] as const) {
    const later = await authorize(
      authorizeBody(base, { phase, authorizationId }),
    );
    expect(later).toEqual({
      allowed: true,
      authorizationId,
      workloadId: base.registration.workloadId,
      generation: 1,
      sessionId,
      secretRef,
      expiresAt: expect.any(String),
    });
    expect(later).not.toHaveProperty('credential');
  }
  const head = await authorize(
    authorizeBody(base, { method: 'HEAD', path: '/' }),
  );
  expect(head.allowed).toBe(true);
  const audit = await db.execute(
    sql`select * from session_egress_audit where workload_id = ${base.registration.workloadId} order by created_at`,
  );
  expect(audit.map((row) => [row.phase, row.decision, row.reason])).toEqual([
    ['request', 'allowed', null],
    ['response', 'allowed', null],
    ['stream', 'allowed', null],
    ['request', 'allowed', null],
  ]);
  for (const row of audit)
    expect(row).toMatchObject({
      session_id: sessionId,
      actor_user_id: ownerId,
      secret_ref: secretRef,
      destination: 'api.example.com:443',
    });
  const serialized = JSON.stringify(audit);
  for (const forbidden of [
    secret,
    base.substitute,
    'private-query-marker',
    '/v1/items',
    'Bearer',
  ])
    expect(serialized).not.toContain(forbidden);
});

it('denies unknown, stolen, misbound, and unscoped substitutes without touching the grant', async () => {
  const a = await registered();
  const earlier = await authorize(authorizeBody(a));
  expect(earlier.allowed).toBe(true);
  if (!earlier.allowed) throw new Error('Expected initial authorization');
  const otherSession = await session(ownerId);
  const otherRun = await run(ownerId, otherSession.id);
  const b = await (async () => {
    const result = await register({ runId: otherRun.id });
    expect(result.status).toBe(201);
    const registration = result.json as SessionEgressWorkloadRegistration;
    expect(registration.substitutes).toEqual([]);
    return {
      registration,
      connectorIdentity: (
        await db.execute<{ connector_identity: string }>(
          sql`select connector_identity from session_egress_workloads where id = ${registration.workloadId}`,
        )
      )[0]!.connector_identity,
    };
  })();
  const cases: [string, SessionEgressAuthorize][] = [
    [
      'unknown_substitute',
      authorizeBody(a, {
        substitute: `${SESSION_EGRESS_SUBSTITUTE_PREFIX}${randomBytes(32).toString('base64url')}`,
      }),
    ],
    // Same owner, other Session's workload presents A's token over its own channel.
    [
      'workload_mismatch',
      authorizeBody(a, {
        workloadId: b.registration.workloadId,
        connectorIdentity: b.connectorIdentity,
      }),
    ],
    // A's workload id claimed over B's authenticated connector.
    [
      'workload_mismatch',
      authorizeBody(a, { connectorIdentity: b.connectorIdentity }),
    ],
    // Unscoped public client: token without any registered channel.
    [
      'workload_mismatch',
      authorizeBody(a, {
        workloadId: randomUUID(),
        connectorIdentity: connector(),
      }),
    ],
  ];
  for (const [reason, body] of cases) {
    // Even an ID from a successful check by the same principal is only correlation.
    expect(
      await authorize({ ...body, authorizationId: earlier.authorizationId }),
    ).toEqual({ allowed: false, reason });
  }
  // Denials that never bound a workload record nothing about a Session or grant.
  const denied = await db.execute(
    sql`select session_id, secret_ref, actor_user_id, decision, reason from session_egress_audit where decision = 'denied' and workload_id in (${a.registration.workloadId}, ${b.registration.workloadId}) order by created_at`,
  );
  expect(denied.map((row) => row.reason)).toEqual([
    'unknown_substitute',
    'workload_mismatch',
    'workload_mismatch',
  ]);
  for (const row of denied)
    expect(row).toMatchObject({
      session_id: null,
      secret_ref: null,
      actor_user_id: null,
      decision: 'denied',
    });
  expect(await authorize(authorizeBody(a))).toMatchObject({ allowed: true });
});

it.each([
  'unattached',
  'other-owner-session',
  'actorless',
  'finished',
] as const)('refuses to register a %s run', async (kind) => {
  let target = runId;
  if (kind === 'unattached') target = (await run(ownerId)).id;
  if (kind === 'other-owner-session') {
    const foreign = await session(otherId);
    target = (await run(ownerId, foreign.id)).id;
  }
  if (kind === 'actorless') target = (await run(null, sessionId)).id;
  if (kind === 'finished')
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, runId));
  const result = await register({ runId: target });
  expect(result).toEqual({ status: 409, json: { error: 'run_not_eligible' } });
  expect(await tableDump()).not.toContain(secret);
});

it.each([
  ['owner-removed', 'session_unavailable'],
  ['archived', 'session_unavailable'],
  ['owner-changed', 'session_unavailable'],
  ['actor-changed', 'session_unavailable'],
  ['detached', 'session_unavailable'],
  ['reattached-elsewhere', 'session_unavailable'],
  ['run-finished', 'session_unavailable'],
  ['grant-expired', 'grant_expired'],
  ['grant-revoked', 'grant_revoked'],
  ['workload-terminated', 'workload_inactive'],
  ['lease-expired', 'workload_inactive'],
] as const)(
  'denies an already-issued substitute after %s, including mid-exchange phases',
  async (kind, reason) => {
    const base = await registered();
    const request = await authorize(authorizeBody(base));
    expect(request.allowed).toBe(true);
    const authorizationId = (request as { authorizationId: string })
      .authorizationId;
    if (kind === 'owner-removed')
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, ownerId));
    if (kind === 'archived')
      await db
        .update(sessions)
        .set({ archivedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    if (kind === 'owner-changed')
      await db
        .update(sessions)
        .set({ ownerUserId: otherId })
        .where(eq(sessions.id, sessionId));
    if (kind === 'actor-changed')
      await db
        .update(taskRuns)
        .set({ actingUserId: otherId })
        .where(eq(taskRuns.id, runId));
    if (kind === 'detached')
      await db.delete(sessionTasks).where(eq(sessionTasks.taskId, taskId));
    if (kind === 'reattached-elsewhere')
      await db
        .update(sessionTasks)
        .set({ sessionId: (await session(ownerId)).id })
        .where(eq(sessionTasks.taskId, taskId));
    if (kind === 'run-finished')
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Canceled })
        .where(eq(taskRuns.id, runId));
    if (kind === 'grant-expired')
      await db.execute(
        sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
      );
    if (kind === 'grant-revoked')
      await revokeSessionSecret(context, { secretRef });
    if (kind === 'workload-terminated') {
      const result = await call(`/workloads/${base.registration.workloadId}`, {
        method: 'DELETE',
        token: await createSessionEgressControllerToken(),
        body: { reason: 'stopped' },
      });
      expect(result).toEqual({
        status: 200,
        json: { workloadId: base.registration.workloadId, terminated: true },
      });
    }
    if (kind === 'lease-expired')
      await db.execute(
        sql`update session_egress_workloads set expires_at = clock_timestamp() - interval '1 second' where id = ${base.registration.workloadId}`,
      );
    for (const phase of ['stream', 'response', 'request'] as const) {
      const decision = await authorize(
        authorizeBody(base, { phase, authorizationId }),
      );
      expect(decision).toEqual({ allowed: false, reason });
    }
    // Neither a lease renewal nor a substitute refresh can resurrect the binding.
    const controller = await createSessionEgressControllerToken();
    const lease = await call(
      `/workloads/${base.registration.workloadId}/lease`,
      {
        token: controller,
        body: { leaseSeconds: 600 },
      },
    );
    const refresh = await call(
      `/workloads/${base.registration.workloadId}/substitutes`,
      {
        token: controller,
      },
    );
    if (kind === 'grant-expired' || kind === 'grant-revoked') {
      expect(lease.status).toBe(200);
      expect(refresh).toMatchObject({ status: 200, json: { substitutes: [] } });
    } else {
      expect(lease).toEqual({
        status: 404,
        json: { error: 'workload_not_found' },
      });
      expect(refresh).toEqual({
        status: 404,
        json: { error: 'workload_not_found' },
      });
    }
    const events = (await call('/revocations', { method: 'GET' })).json;
    if (kind === 'grant-revoked')
      expect(events.events).toContainEqual(
        expect.objectContaining({ kind: 'grant', secretRef, workloadId: null }),
      );
    if (kind === 'workload-terminated')
      expect(events.events).toContainEqual(
        expect.objectContaining({
          kind: 'workload',
          workloadId: base.registration.workloadId,
        }),
      );
    expect(JSON.stringify(events)).not.toContain(base.substitute);
    expect(await tableDump()).not.toContain(base.substitute);
  },
);

function isAuditRaceTestDatabase(name: string | undefined): boolean {
  return name === 'test' || name?.endsWith('_test') === true;
}

it.each([
  ['test', true],
  ['roomote_test', true],
  ['roomote_session_secrets_test', true],
  ['_test', true],
  [undefined, false],
  ['', false],
  ['postgres', false],
  ['roomote_development', false],
  ['production', false],
  ['contest', false],
  ['test_backup', false],
  ['roomote_test_backup', false],
  ['roomote-test', false],
  ['TEST', false],
  ['test\n', false],
  ['roomote_test\n', false],
] as const)('audit race database guard: %j is allowed=%s', (name, allowed) => {
  expect(isAuditRaceTestDatabase(name)).toBe(allowed);
});

describe.each(['request', 'response', 'stream'] as const)(
  'audit wait race: %s',
  (phase) => {
    it.each([
      ['revoke', 'grant_revoked'],
      ['expiry', 'grant_expired'],
      ['generation', 'stale_generation'],
      ['actor', 'session_unavailable'],
    ] as const)(
      'denies after %s during the audit insert',
      async (change, reason) => {
        const [database] = await db.execute<{ name: string }>(
          sql`select current_database() as name`,
        );
        // Check the live DB before locking: CI uses "test", local DBs use "*_test".
        expect(isAuditRaceTestDatabase(database?.name)).toBe(true);
        const base = await registered();
        const authorizationId = randomUUID();
        let pending: Promise<SessionEgressAuthorization> | undefined;
        try {
          await db.transaction(async (lock) => {
            await lock.execute(sql`set local statement_timeout = '5s'`);
            await lock.execute(
              sql`set local idle_in_transaction_session_timeout = '10s'`,
            );
            const [holder] = await lock.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            await lock.execute(
              sql`lock table session_egress_audit in access exclusive mode`,
            );
            pending = authorize(
              authorizeBody(base, { phase, authorizationId }),
            );
            void pending.catch(() => undefined);
            // Observe the real INSERT waiting on this separate connection's lock,
            // rather than guessing when the initial authorization SELECT finished.
            await expect
              .poll(
                async () => {
                  const [blocked] = await db.execute<{ waiting: boolean }>(sql`
              select exists (
                select 1 from pg_locks l
                join pg_stat_activity a on a.pid = l.pid
                where l.relation = 'session_egress_audit'::regclass
                  and l.mode = 'RowExclusiveLock' and not l.granted
                  and a.datname = current_database()
                  and a.wait_event_type = 'Lock'
                  and a.query ilike 'insert into "session_egress_audit"%'
                  and ${holder!.pid} = any(pg_blocking_pids(a.pid))
              ) as waiting
            `);
                  return blocked?.waiting;
                },
                { timeout: 3_000, interval: 10 },
              )
              .toBe(true);
            if (change === 'revoke')
              await db
                .update(sessionSecrets)
                .set({ revokedAt: new Date() })
                .where(eq(sessionSecrets.id, secretRef));
            if (change === 'expiry')
              await db.execute(
                sql`update session_secrets set expires_at = clock_timestamp() - interval '1 second' where id = ${secretRef}`,
              );
            if (change === 'generation')
              await db.execute(
                sql`update session_egress_workloads set generation = generation + 1 where id = ${base.registration.workloadId}`,
              );
            if (change === 'actor')
              await db
                .update(taskRuns)
                .set({ actingUserId: otherId })
                .where(eq(taskRuns.id, runId));
          });
          const result = await pending!;
          // Assert nonsecret fields first so a regressing request cannot print its key.
          expect(result.allowed).toBe(false);
          expect('credential' in result).toBe(false);
          expect(result).toEqual({ allowed: false, reason });
          const attempts = await db
            .select({
              id: sessionEgressAudit.id,
              authorizationId: sessionEgressAudit.authorizationId,
              decision: sessionEgressAudit.decision,
            })
            .from(sessionEgressAudit)
            .where(
              eq(sessionEgressAudit.workloadId, base.registration.workloadId),
            );
          // The pre-wait evaluation was allowed, but is not evidence of release.
          expect(attempts).toEqual([
            { id: expect.any(String), authorizationId, decision: 'allowed' },
          ]);
        } finally {
          // transaction() commits/rolls back (and releases the lock) even if polling
          // or mutation fails; server timeouts bound a stranded lock as a backstop.
          await pending?.catch(() => undefined);
        }
      },
      15_000,
    );
  },
);

it('rotates the generation on re-registration and invalidates earlier substitutes', async () => {
  const first = await registered();
  const rotatedIdentity = connector();
  const result = await register({ connectorIdentity: rotatedIdentity });
  expect(result.status).toBe(201);
  const second = result.json as SessionEgressWorkloadRegistration;
  expect(second.workloadId).toBe(first.registration.workloadId);
  expect(second.generation).toBe(2);
  expect(second.substitutes).toHaveLength(1);
  expect(second.substitutes[0]!.substitute).not.toBe(first.substitute);
  // Old token over the old channel: the channel no longer belongs to the workload.
  expect(await authorize(authorizeBody(first))).toEqual({
    allowed: false,
    reason: 'workload_mismatch',
  });
  // Old token smuggled over the rotated channel.
  expect(
    await authorize(
      authorizeBody(first, { connectorIdentity: rotatedIdentity }),
    ),
  ).toEqual({ allowed: false, reason: 'stale_generation' });
  const current = {
    registration: second,
    connectorIdentity: rotatedIdentity,
    substitute: second.substitutes[0]!.substitute,
  };
  expect(await authorize(authorizeBody(current))).toMatchObject({
    allowed: true,
    generation: 2,
    credential: { value: secret },
  });
  const feed = (await call('/revocations', { method: 'GET' })).json;
  expect(feed.events).toContainEqual(
    expect.objectContaining({
      kind: 'generation',
      workloadId: second.workloadId,
      generation: 2,
    }),
  );
  // A connector identity still bound to another live workload cannot be reused.
  const otherRun = await run(ownerId, (await session(ownerId)).id);
  expect(
    await register({ runId: otherRun.id, connectorIdentity: rotatedIdentity }),
  ).toEqual({
    status: 409,
    json: { error: 'connector_identity_in_use' },
  });
});

it('issues substitutes for grants approved after registration without rotating', async () => {
  const base = await registered();
  const controller = await createSessionEgressControllerToken();
  const nothing = await call(
    `/workloads/${base.registration.workloadId}/substitutes`,
    {
      token: controller,
    },
  );
  expect(nothing).toMatchObject({
    status: 200,
    json: { generation: 1, substitutes: [] },
  });
  const pending = await prepareSessionSecret(context, {
    label: 'Second API',
    origin: 'https://second.example.com:8443',
    headerName: 'x-api-key',
    headerPrefix: '',
  });
  const second = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret: 'second-real-key-value-9876',
  });
  const issued = await call(
    `/workloads/${base.registration.workloadId}/substitutes`,
    {
      token: controller,
    },
  );
  expect(issued.status).toBe(200);
  const registration = issued.json as SessionEgressWorkloadRegistration;
  expect(registration.generation).toBe(1);
  expect(registration.substitutes).toHaveLength(1);
  expect(registration.substitutes[0]).toMatchObject({
    secretRef: second.secretRef,
    origin: 'https://second.example.com:8443',
    headerName: 'x-api-key',
    headerPrefix: '',
  });
  minted.push(registration.substitutes[0]!.substitute);
  const bound = {
    ...base,
    substitute: registration.substitutes[0]!.substitute,
  };
  expect(
    await authorize(
      authorizeBody(bound, {
        destination: { host: 'second.example.com', port: 443 },
      }),
    ),
  ).toEqual({ allowed: false, reason: 'destination_mismatch' });
  expect(
    await authorize(
      authorizeBody(bound, {
        destination: { host: 'second.example.com', port: 8443 },
      }),
    ),
  ).toMatchObject({
    allowed: true,
    secretRef: second.secretRef,
    credential: {
      headerName: 'x-api-key',
      headerPrefix: '',
      value: 'second-real-key-value-9876',
    },
  });
  // The first substitute still resolves only its own grant.
  expect(await authorize(authorizeBody(base))).toMatchObject({
    allowed: true,
    secretRef,
  });
});

it('binds authorization to the exact approved origin and method policy', async () => {
  const base = await registered();
  for (const [destination, reason] of [
    [{ host: 'api.example.com', port: 8443 }, 'destination_mismatch'],
    [{ host: 'evil.example.com', port: 443 }, 'destination_mismatch'],
    [
      { host: 'api.example.com.evil.example', port: 443 },
      'destination_mismatch',
    ],
  ] as const) {
    expect(await authorize(authorizeBody(base, { destination }))).toEqual({
      allowed: false,
      reason,
    });
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    expect(await authorize(authorizeBody(base, { method }))).toEqual({
      allowed: false,
      reason: 'method_not_allowed',
    });
  }
  for (const body of [
    undefined,
    'not json',
    {},
    { ...authorizeBody(base), extra: true },
    { ...authorizeBody(base), destination: { host: '10.0.0.1', port: 443 } },
    {
      ...authorizeBody(base),
      destination: { host: 'api.example.com:443', port: 443 },
    },
    { ...authorizeBody(base), path: 'relative' },
    { ...authorizeBody(base), path: '/has space' },
    { ...authorizeBody(base), method: 'OPTIONS' },
    { ...authorizeBody(base), substitute: secret },
  ]) {
    expect(await authorize(body)).toEqual({
      allowed: false,
      reason: 'malformed',
    });
  }
  const audit = await db.execute(
    sql`select decision, reason from session_egress_audit where workload_id = ${base.registration.workloadId}`,
  );
  expect(audit.every((row) => row.decision === 'denied')).toBe(true);
  expect(audit.map((row) => row.reason).sort()).toEqual(
    [
      ...Array<string>(3).fill('destination_mismatch'),
      ...Array<string>(4).fill('method_not_allowed'),
    ].sort(),
  );
});

it('allows write methods only for grants the owner explicitly acknowledged, without widening older grants', async () => {
  const pending = await prepareSessionSecret(context, {
    label: 'Write API',
    origin: 'https://write.example.com',
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
    allowedMethods: ['POST', 'GET'],
  });
  expect(pending.allowedMethods).toEqual(['GET', 'POST']);
  for (const allowedMethods of [
    undefined,
    ['GET'],
    ['GET', 'HEAD'],
    ['GET', 'POST', 'DELETE'],
  ]) {
    await expect(
      createSessionSecret(context, {
        pendingRef: pending.pendingRef,
        secret: 'write-capable-key-000111',
        ...(allowedMethods ? { allowedMethods } : {}),
      }),
    ).rejects.toThrow(/^Secret request unavailable$/);
  }
  const write = await createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret: 'write-capable-key-000111',
    allowedMethods: ['POST', 'GET'],
  });
  expect(write.allowedMethods).toEqual(['GET', 'POST']);
  const base = await registered();
  const issue = base.registration.substitutes.find(
    (item) => item.secretRef === write.secretRef,
  )!;
  expect(issue.allowedMethods).toEqual(['GET', 'POST']);
  const bound = { ...base, substitute: issue.substitute };
  const destination = { host: 'write.example.com', port: 443 };
  expect(
    await authorize(authorizeBody(bound, { destination, method: 'POST' })),
  ).toMatchObject({
    allowed: true,
    credential: { value: 'write-capable-key-000111' },
  });
  expect(
    await authorize(authorizeBody(bound, { destination, method: 'HEAD' })),
  ).toEqual({
    allowed: false,
    reason: 'method_not_allowed',
  });
  expect(
    await authorize(authorizeBody(bound, { destination, method: 'DELETE' })),
  ).toEqual({
    allowed: false,
    reason: 'method_not_allowed',
  });
  // The read-only grant prepared without a policy stays GET/HEAD-only everywhere.
  expect(await authorize(authorizeBody(base, { method: 'POST' }))).toEqual({
    allowed: false,
    reason: 'method_not_allowed',
  });
  // The legacy broker path is not broadened either: POST stays refused there.
  await expect(
    integrationRequest(
      { integrations: [] },
      `egress-test:${sessionId}`,
      {
        integrationId: `session:${write.secretRef}`,
        method: 'POST',
        path: '/x',
        body: '{}',
      },
      ownerId,
      undefined,
      async () => context,
    ),
  ).rejects.toThrow(/^Secret request unavailable$/);
});

it('pages the revocation feed by cursor', async () => {
  const base = await registered();
  await register();
  await revokeSessionSecret(context, { secretRef });
  const controller = await createSessionEgressControllerToken();
  await call(`/workloads/${base.registration.workloadId}`, {
    method: 'DELETE',
    token: controller,
  });
  const all = (await call('/revocations', { method: 'GET' })).json;
  const own = all.events.filter(
    (event: { workloadId: string | null; secretRef: string | null }) =>
      event.workloadId === base.registration.workloadId ||
      event.secretRef === secretRef,
  );
  expect(own.map((event: { kind: string }) => event.kind)).toEqual([
    'generation',
    'grant',
    'workload',
  ]);
  const firstId = own[0].id as number;
  const page = await app.request(
    `${path}/revocations?after=${firstId - 1}&limit=1`,
    {
      headers: { authorization: `Bearer ${GATEWAY}` },
    },
  );
  const paged = await page.json();
  expect(paged.events).toHaveLength(1);
  expect(paged.events[0]).toMatchObject({
    id: firstId,
    kind: 'generation',
    generation: 2,
  });
  expect(paged.cursor).toBe(firstId);
  const bad = await app.request(`${path}/revocations?after=-1`, {
    headers: { authorization: `Bearer ${GATEWAY}` },
  });
  expect(bad.status).toBe(400);
});

it('drives the controller flow through the typed SDK client', async () => {
  const client = createSessionEgressControllerClient({
    apiBaseUrl: 'http://api.internal/',
    fetch: async (input, init) =>
      app.request(String(input).replace('http://api.internal', ''), init),
  });
  const registration = await client.register({
    runId,
    provider: 'docker',
    connectorIdentity: connector(),
    leaseSeconds: 120,
  });
  minted.push(...registration.substitutes.map((issue) => issue.substitute));
  expect(registration.substitutes).toHaveLength(1);
  const lease = await client.renewLease(registration.workloadId, {
    leaseSeconds: 300,
  });
  expect(lease).toMatchObject({
    workloadId: registration.workloadId,
    generation: 1,
  });
  expect(Date.parse(lease.expiresAt)).toBeGreaterThan(
    Date.parse(registration.expiresAt),
  );
  expect(await client.issueSubstitutes(registration.workloadId)).toMatchObject({
    substitutes: [],
  });
  expect(
    await client.terminate(registration.workloadId, { reason: 'stopped' }),
  ).toEqual({
    workloadId: registration.workloadId,
    terminated: true,
  });
  expect(
    await client.terminate(registration.workloadId, { reason: 'cleanup' }),
  ).toEqual({
    workloadId: registration.workloadId,
    terminated: false,
  });
  await expect(
    client.renewLease(registration.workloadId, { leaseSeconds: 300 }),
  ).rejects.toThrow(/404 workload_not_found/);
});
