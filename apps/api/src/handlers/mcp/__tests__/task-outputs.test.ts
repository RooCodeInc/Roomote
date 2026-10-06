import type { Context, Next } from 'hono';
import { getRoomoteMcpResourceUrl } from '@roomote/auth';
import { Env } from '@roomote/env';
import {
  automations,
  customAutomations,
  db,
  eq,
  inArray,
  runFactory,
  sql,
  taskArtifacts,
  taskFactory,
  taskMessages,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  RunStatus,
} from '@roomote/types';

import type { Variables } from '../../../types';

const state = vi.hoisted(() => ({
  credentials: new Map<string, Variables['authContext']>(),
  object: vi.fn(),
}));
vi.mock('../../../middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../middleware')>()),
  tokenAuthMiddleware:
    () => async (c: Context<{ Variables: Variables }>, next: Next) => {
      const auth = state.credentials.get(c.req.header('authorization') ?? '');
      if (auth) c.set('authContext', auth);
      await next();
    },
}));
vi.mock('../../artifacts/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../artifacts/storage')>()),
  getArtifactObject: state.object,
}));

import { createApiApp } from '../../../server';

const createdTasks: string[] = [];
const createdUsers: string[] = [];
const createdAutomations: string[] = [];
let owner: Awaited<ReturnType<typeof userFactory.create>>;
let other: typeof owner;
let admin: typeof owner;
let task: Awaited<ReturnType<typeof taskFactory.create>>;
let run: Awaited<ReturnType<typeof runFactory.create>>;

async function createTask(
  params: Parameters<typeof taskFactory.create>[0] = {},
) {
  const result = await taskFactory.create({ state: 'completed', ...params });
  createdTasks.push(result.id);
  return result;
}

function credential(userId: string, kind: 'oauth' | 'user' = 'oauth') {
  const token = `Bearer test-${kind}-${userId}`;
  state.credentials.set(
    token,
    kind === 'oauth'
      ? {
          userId,
          tokenType: 'mcp',
          resource: getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
          scopes: ['mcp:roomote'],
          version: 1,
        }
      : { userId, tokenType: 'auth', version: 1 },
  );
  return token;
}

async function call(
  arguments_: Record<string, unknown>,
  authorization = credential(owner.id),
) {
  const response = await createApiApp().request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      authorization,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'manage_tasks', arguments: arguments_ },
    }),
  });
  const body = await response.json();
  return {
    response,
    result: body.result,
    data: body.result?.structuredContent,
  };
}

async function artifact(
  path = 'tmp/proof.png',
  version = 1,
  uploaded = true,
  taskId = task.id,
) {
  const [result] = await db
    .insert(taskArtifacts)
    .values({
      taskId,
      runId: taskId === task.id ? run.id : null,
      path,
      version,
      uploaded,
      size: 5,
      contentType: path.endsWith('.png') ? 'image/png' : 'text/plain',
      artifactType: path.endsWith('.png') ? 'visual-proof' : 'general',
    })
    .returning();
  return result!;
}

async function receipt(
  ts: number,
  payload: Record<string, unknown> = {},
  createdAt = '2026-01-01 00:00:00.000001',
) {
  const [result] = await db
    .insert(taskMessages)
    .values({
      taskId: task.id,
      runId: run.id,
      ts,
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      createdAt: sql`${createdAt}::timestamp`,
      contentBlocks: [],
      payload: {
        isExecute: true,
        toolCallId: `call-${ts}`,
        command: `command-${ts}`,
        exitCode: 0,
        output: 'done',
        status: 'completed',
        ...payload,
      },
    })
    .returning();
  return result!;
}

beforeEach(async () => {
  state.credentials.clear();
  state.object.mockReset();
  state.object.mockImplementation(async () => ({
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
            controller.close();
          },
        }),
    },
  }));
  owner = await userFactory.create({ role: 'member' });
  other = await userFactory.create({ role: 'member' });
  admin = await userFactory.create({ role: 'admin' });
  createdUsers.push(owner.id, other.id, admin.id);
  task = await createTask();
  run = await runFactory.create({
    taskId: task.id,
    status: RunStatus.Completed,
  });
});

afterEach(async () => {
  if (createdTasks.length)
    await db.delete(tasks).where(inArray(tasks.id, createdTasks));
  if (createdAutomations.length)
    await db
      .delete(customAutomations)
      .where(inArray(customAutomations.id, createdAutomations));
  if (createdUsers.length)
    await db.delete(users).where(inArray(users.id, createdUsers));
  createdTasks.length = 0;
  createdUsers.length = 0;
  createdAutomations.length = 0;
});

it.each(['oauth', 'user'] as const)(
  'lists only latest uploaded paths with %s public credentials',
  async (kind) => {
    await artifact('tmp/proof.png', 1);
    const latest = await artifact('tmp/proof.png', 2);
    await artifact('tmp/proof.png', 3, false);
    const log = await artifact('logs/test.log');
    const unrelated = await createTask();
    await artifact('logs/unrelated.log', 1, true, unrelated.id);
    const { result, data } = await call(
      { action: 'list_artifacts', taskId: task.id },
      credential(owner.id, kind),
    );
    expect(result.isError).not.toBe(true);
    expect(data.artifacts).toHaveLength(2);
    expect(data.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: latest.id,
          taskId: task.id,
          runId: run.id,
          path: latest.path,
          version: 2,
          size: 5,
        }),
        expect.objectContaining({ id: log.id, contentType: 'text/plain' }),
      ]),
    );
    expect(data.artifacts[0]).not.toHaveProperty('url');
    const filtered = await call(
      { action: 'list_artifacts', taskId: task.id, artifactType: 'general' },
      credential(owner.id, kind),
    );
    expect(
      filtered.data.artifacts.map((item: { id: string }) => item.id),
    ).toEqual([log.id]);
  },
);

it.each(['oauth', 'user'] as const)(
  'issues owner-only downloads usable with the same %s credential, without cookies or presigns',
  async (kind) => {
    await db
      .update(tasks)
      .set({ privacy: 'private', privateOwnerUserId: owner.id })
      .where(eq(tasks.id, task.id));
    const file = await artifact();
    const authorization = credential(owner.id, kind);
    const { data } = await call(
      { action: 'get_artifact_download_url', taskId: task.id, path: file.path },
      authorization,
    );
    expect(data).toMatchObject({
      id: file.id,
      authentication: 'bearer',
      expiresAt: null,
    });
    const url = new URL(data.url);
    expect(url.pathname.endsWith('/mcp/task-outputs/download')).toBe(true);
    expect(url.searchParams.get('artifactId')).toBe(file.id);
    expect(url.searchParams.has('sig')).toBe(false);
    const downloaded = await createApiApp().request(
      `${url.pathname}${url.search}`,
      { headers: { authorization } },
    );
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
    expect(downloaded.headers.get('content-disposition')).toContain(
      'attachment;',
    );
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
    for (const user of [other, admin]) {
      const denied = await createApiApp().request(
        `${url.pathname}${url.search}`,
        { headers: { authorization: credential(user.id, kind) } },
      );
      expect(denied.status).toBe(404);
      const listed = await call(
        { action: 'list_artifacts', taskId: task.id },
        credential(user.id, kind),
      );
      expect(listed.result.isError).toBe(true);
      expect(listed.data.status).toBe(404);
      expect(
        (
          await call(
            {
              action: 'get_artifact_download_url',
              taskId: task.id,
              path: file.path,
            },
            credential(user.id, kind),
          )
        ).data.status,
      ).toBe(404);
      expect(
        (
          await call(
            { action: 'get_command_receipts', taskId: task.id },
            credential(user.id, kind),
          )
        ).data.status,
      ).toBe(404);
    }
    expect(state.object).toHaveBeenCalledTimes(1);
  },
);

it('rechecks shared-to-private changes and revoked credentials at download time', async () => {
  const file = await artifact();
  const token = credential(other.id);
  const issued = await call(
    { action: 'get_artifact_download_url', taskId: task.id, path: file.path },
    token,
  );
  const url = new URL(issued.data.url);
  await db
    .update(tasks)
    .set({ privacy: 'private', privateOwnerUserId: owner.id })
    .where(eq(tasks.id, task.id));
  expect(
    (
      await createApiApp().request(url.pathname + url.search, {
        headers: { authorization: token },
      })
    ).status,
  ).toBe(404);
  state.credentials.delete(token);
  expect(
    (
      await createApiApp().request(url.pathname + url.search, {
        headers: { authorization: token },
      })
    ).status,
  ).toBe(401);
  expect(state.object).not.toHaveBeenCalled();
});

it.each(['hidden', 'archived', 'deleted'] as const)(
  'rejects %s tasks for every read and download',
  async (state_) => {
    const file = await artifact();
    await db
      .update(tasks)
      .set(
        state_ === 'hidden'
          ? { visibility: 'hidden' }
          : state_ === 'archived'
            ? { archivedAt: new Date() }
            : { deletedAt: new Date() },
      )
      .where(eq(tasks.id, task.id));
    for (const input of [
      { action: 'list_artifacts', taskId: task.id },
      { action: 'get_artifact_download_url', taskId: task.id, path: file.path },
      { action: 'get_command_receipts', taskId: task.id },
    ])
      expect((await call(input)).data.status).toBe(404);
    const downloaded = await createApiApp().request(
      `/mcp/task-outputs/download?taskId=${task.id}&artifactId=${file.id}`,
      { headers: { authorization: credential(owner.id) } },
    );
    expect(downloaded.status).toBe(404);
    expect(state.object).not.toHaveBeenCalled();
  },
);

it('preserves custom-automation history ownership and admin access', async () => {
  await db
    .insert(automations)
    .values({ key: 'custom_automation' })
    .onConflictDoNothing();
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: 'Task output access test',
      prompt: 'Test',
      createdByUserId: owner.id,
    })
    .returning();
  createdAutomations.push(automation!.id);
  await db
    .update(tasks)
    .set({
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'custom_automation',
      actorExternalId: automation!.id,
    })
    .where(eq(tasks.id, task.id));
  expect(
    (
      await call(
        { action: 'list_artifacts', taskId: task.id },
        credential(other.id),
      )
    ).data.status,
  ).toBe(404);
  for (const user of [owner, admin])
    expect(
      (
        await call(
          { action: 'get_command_receipts', taskId: task.id },
          credential(user.id),
        )
      ).result.isError,
    ).not.toBe(true);
});

it('uses exact versions and fails closed for incomplete, missing or cross-task files', async () => {
  const first = await artifact('tmp/proof.png', 1);
  await artifact('tmp/proof.png', 2);
  await artifact('tmp/proof.png', 3, false);
  const exact = await call({
    action: 'get_artifact_download_url',
    taskId: task.id,
    path: first.path,
    version: 1,
  });
  expect(exact.data.id).toBe(first.id);
  expect(
    (
      await call({
        action: 'get_artifact_download_url',
        taskId: task.id,
        path: first.path,
        version: 3,
      })
    ).data.status,
  ).toBe(409);
  expect(
    (
      await call({
        action: 'get_artifact_download_url',
        taskId: task.id,
        path: 'missing.log',
      })
    ).data.status,
  ).toBe(404);
  const anotherTask = await createTask();
  const cross = await createApiApp().request(
    `/mcp/task-outputs/download?taskId=${anotherTask.id}&artifactId=${first.id}`,
    { headers: { authorization: credential(owner.id) } },
  );
  expect(cross.status).toBe(404);
  expect(state.object).not.toHaveBeenCalled();
});

it('paginates durable receipts without loss at sub-millisecond timestamp boundaries', async () => {
  const output = 'x'.repeat(30_000);
  const a = await receipt(100, { output, exitCode: null });
  const b = await receipt(
    101,
    { exitCode: 2, status: 'failed' },
    '2026-01-01 00:00:00.000002',
  );
  const c = await receipt(102, {}, '2026-01-01 00:00:00.000002');
  await receipt(103, { isExecute: false, isMcp: true });
  const first = await call({
    action: 'get_command_receipts',
    taskId: task.id,
    limit: 1,
  });
  expect(first.data.receipts).toHaveLength(1);
  expect(first.data.receipts[0]).toMatchObject({
    id: a.id,
    runId: run.id,
    toolCallId: 'call-100',
    command: 'command-100',
    exitCode: null,
    status: 'completed',
    outputTruncation: {
      originalChars: 30_000,
      keptChars: 20_000,
      strategy: 'head_tail',
    },
  });
  expect(first.data.receipts[0].output.length).toBeLessThan(20_100);
  const second = await call({
    action: 'get_command_receipts',
    taskId: task.id,
    limit: 1,
    cursor: first.data.nextCursor,
  });
  expect(second.data.receipts[0]).toMatchObject({
    id: b.id,
    exitCode: 2,
    status: 'failed',
    outputTruncation: null,
  });
  const third = await call(
    {
      action: 'get_command_receipts',
      taskId: task.id,
      limit: 1,
      cursor: second.data.nextCursor,
    },
    credential(owner.id, 'user'),
  );
  expect(third.data.receipts.map((item: { id: string }) => item.id)).toEqual([
    c.id,
  ]);
  expect(third.data.nextCursor).toBeNull();
  const anotherTask = await createTask();
  expect(
    (
      await call({
        action: 'get_command_receipts',
        taskId: anotherTask.id,
        cursor: first.data.nextCursor,
      })
    ).data.status,
  ).toBe(400);
  expect(
    (
      await call({
        action: 'get_command_receipts',
        taskId: task.id,
        cursor: 'not-a-cursor',
      })
    ).data.status,
  ).toBe(400);
  await db
    .update(tasks)
    .set({ privacy: 'private', privateOwnerUserId: other.id })
    .where(eq(tasks.id, task.id));
  expect(
    (
      await call({
        action: 'get_command_receipts',
        taskId: task.id,
        cursor: first.data.nextCursor,
      })
    ).data.status,
  ).toBe(404);
});

it('rejects absent, wrong-resource, wrong-scope and run credentials on download without touching storage', async () => {
  const file = await artifact();
  const input = `/mcp/task-outputs/download?taskId=${task.id}&artifactId=${file.id}`;
  const valid = state.credentials.get(credential(owner.id))!;
  state.credentials.set('Bearer wrong-resource', {
    ...valid,
    tokenType: 'mcp',
    userId: owner.id,
    resource: 'https://other.example/mcp',
    scopes: ['mcp:roomote'],
    version: 1,
  });
  state.credentials.set('Bearer wrong-scope', {
    ...valid,
    tokenType: 'mcp',
    userId: owner.id,
    resource: getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
    scopes: [],
    version: 1,
  });
  state.credentials.set('Bearer run', {
    tokenType: 'run',
    runId: run.id,
    userId: owner.id,
    principal: 'user',
    version: 1,
  });
  for (const authorization of [
    '',
    'Bearer wrong-resource',
    'Bearer wrong-scope',
    'Bearer run',
  ]) {
    const response = await createApiApp().request(input, {
      headers: { authorization },
    });
    expect(response.status).toBe(authorization ? 403 : 401);
  }
  expect(
    (await createApiApp().request(input + '&access_token=not-a-credential'))
      .status,
  ).toBe(401);
  const challenge = await createApiApp().request(input);
  expect(challenge.headers.get('www-authenticate')).toContain(
    '/.well-known/oauth-protected-resource/mcp',
  );
  expect(state.object).not.toHaveBeenCalled();
});

it('advertises new public action fields and rejects missing paths and invalid receipt limits', async () => {
  const response = await createApiApp().request('/mcp', {
    method: 'POST',
    headers: {
      authorization: credential(owner.id),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = await response.json();
  const tool = body.result.tools.find(
    (item: { name: string }) => item.name === 'manage_tasks',
  );
  expect(tool.inputSchema.properties.action.enum).toEqual(
    expect.arrayContaining([
      'list_artifacts',
      'get_artifact_download_url',
      'get_command_receipts',
      'get_compute_logs',
    ]),
  );
  expect(tool.inputSchema.properties).toHaveProperty('path');
  expect(
    (await call({ action: 'get_artifact_download_url', taskId: task.id })).data
      .status,
  ).toBe(400);
  expect(
    (
      await call({
        action: 'get_command_receipts',
        taskId: task.id,
        limit: 101,
      })
    ).data.status,
  ).toBe(400);
});
