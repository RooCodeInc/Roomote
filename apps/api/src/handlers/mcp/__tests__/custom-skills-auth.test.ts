import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  db,
  eq,
  inArray,
  instanceSkills,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type AuthTokenContext,
  type RunTokenContext,
} from '@roomote/types';
import type { Variables } from '../../../types';
import { mcp } from '../index';

const userIds: string[] = [];
const taskIds: string[] = [];
const skillNames: string[] = [];
const skill = {
  description: 'Use when reviewing examples.',
  content: 'Check examples.\n',
};

function app(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  // Only the upstream bearer-auth result is supplied; the real mount must set mcpAuth.
  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });
  app.route('/api/mcp', mcp);
  return app;
}

function createSkill(
  authContext: AuthTokenContext | RunTokenContext,
  extra = {},
) {
  const name = `worker-checklist-${randomUUID()}`;
  skillNames.push(name);
  return {
    name,
    response: app(authContext).request('/api/mcp/custom-skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...skill, name, ...extra }),
    }),
  };
}

async function runContext(ownerId: string, actingUserId: string | null) {
  const task = await taskFactory.create({ initiatorUserId: ownerId });
  taskIds.push(task.id);
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      actingUserId,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: '', description: 'Create example skill' },
    })
    .returning({ id: taskRuns.id });
  return {
    runId: run!.id,
    userId: ownerId,
    principal: 'user',
    tokenType: 'run',
    version: 1,
  } satisfies RunTokenContext;
}

afterEach(async () => {
  if (skillNames.length)
    await db
      .delete(instanceSkills)
      .where(inArray(instanceSkills.name, skillNames.splice(0)));
  if (taskIds.length)
    await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it.each(['/api/mcp/custom-skills', '/api/mcp/custom-skills/'])(
  'requires authentication at the mounted %s route',
  async (path) => {
    const response = await app().request(path, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required',
    });
  },
);

it.each(['auth', 'run', 'deployment-run'] as const)(
  'allows a member %s context and persists an instance skill under the live actor',
  async (tokenType) => {
    const member = await userFactory.create({ role: 'member' });
    const owner = await userFactory.create({ role: 'admin' });
    userIds.push(member.id, owner.id);
    const authContext: AuthTokenContext | RunTokenContext =
      tokenType !== 'auth'
        ? await runContext(owner.id, member.id)
        : ({
            userId: member.id,
            tokenType: 'auth',
            version: 1,
          } satisfies AuthTokenContext);
    if (tokenType === 'deployment-run' && authContext.tokenType === 'run') {
      authContext.userId = null;
      authContext.principal = 'deployment';
    }
    const { name, response } = createSkill(authContext);
    expect((await response).status).toBe(201);
    await expect((await response).json()).resolves.toMatchObject({
      persisted: true,
      scope: 'instance',
      name,
    });
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, name),
      }),
    ).toMatchObject({ ...skill, name, createdByUserId: member.id });
    const stored = await db.query.instanceSkills.findFirst({
      where: eq(instanceSkills.name, name),
    });
    const updated = await app(authContext).request('/api/mcp/custom-skills', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skillId: `instance:${stored!.id}`,
        expectedVersion: 1,
        content: {
          type: 'replace_content',
          replace_content: { new_str: 'Updated instructions.\n' },
        },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ version: 2 });

    // The same token must observe the current actor state, never its durable owner.
    if (authContext.tokenType === 'run') {
      await db
        .update(taskRuns)
        .set({ actingUserId: null })
        .where(eq(taskRuns.id, authContext.runId));
    } else {
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, member.id));
    }
    const denied = createSkill(authContext);
    expect((await denied.response).status).toBe(403);
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, denied.name),
      }),
    ).toBeUndefined();
  },
);

it.each(['missing', 'deleted', 'unknown-run', 'unknown-user'] as const)(
  'denies a %s actor without creating an instance skill',
  async (state) => {
    const owner = await userFactory.create({ role: 'admin' });
    const actor = await userFactory.create({
      role: 'member',
      deletedAt: new Date(),
    });
    userIds.push(owner.id, actor.id);
    const context: AuthTokenContext | RunTokenContext =
      state === 'unknown-user'
        ? { userId: randomUUID(), tokenType: 'auth', version: 1 }
        : await runContext(owner.id, state === 'deleted' ? actor.id : null);
    if (state === 'unknown-run' && context.tokenType === 'run') {
      await db.delete(taskRuns).where(eq(taskRuns.id, context.runId));
    }
    const { name, response } = createSkill(context);
    expect((await response).status).toBe(403);
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, name),
      }),
    ).toBeUndefined();
  },
);

it.each([
  { environmentIds: [randomUUID()] },
  { environmentId: randomUUID() },
  { workspaceId: randomUUID() },
  { createdByUserId: randomUUID() },
  { actorUserId: randomUUID() },
])(
  'rejects caller-provided scope or identity %j at the mount',
  async (extra) => {
    const member = await userFactory.create({ role: 'member' });
    userIds.push(member.id);
    const { name, response } = createSkill(
      { userId: member.id, tokenType: 'auth', version: 1 },
      extra,
    );
    expect((await response).status).toBe(400);
    expect(
      await db.query.instanceSkills.findFirst({
        where: eq(instanceSkills.name, name),
      }),
    ).toBeUndefined();
  },
);
