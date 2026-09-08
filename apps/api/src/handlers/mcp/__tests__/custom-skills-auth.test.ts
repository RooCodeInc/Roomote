import { Hono } from 'hono';
import {
  db,
  environmentFactory,
  environments,
  eq,
  inArray,
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
const environmentIds: string[] = [];
const taskIds: string[] = [];
const skill = {
  name: 'worker-example-checklist',
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

afterEach(async () => {
  if (taskIds.length)
    await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
  if (environmentIds.length)
    await db
      .delete(environments)
      .where(inArray(environments.id, environmentIds.splice(0)));
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

it.each(['auth', 'run'] as const)(
  'allows an admin %s context through the actual mount and persists the skill',
  async (tokenType) => {
    const admin = await userFactory.create({ role: 'admin' });
    userIds.push(admin.id);
    const environment = await environmentFactory.create({
      createdByUserId: admin.id,
      config: {
        name: 'Worker skill test',
        repositories: [{ repository: 'example/repo' }],
      },
    });
    environmentIds.push(environment.id);
    let authContext: AuthTokenContext | RunTokenContext = {
      userId: admin.id,
      tokenType: 'auth',
      version: 1,
    };
    let runId: number | undefined;
    if (tokenType === 'run') {
      const task = await taskFactory.create({ initiatorUserId: admin.id });
      taskIds.push(task.id);
      const [run] = await db
        .insert(taskRuns)
        .values({
          taskId: task.id,
          actingUserId: admin.id,
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: '', description: 'Create example skill' },
        })
        .returning({ id: taskRuns.id });
      runId = run!.id;
      authContext = {
        runId,
        userId: null,
        principal: 'deployment',
        tokenType: 'run',
        version: 1,
      };
    }
    const response = await app(authContext).request('/api/mcp/custom-skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...skill, environmentIds: [environment.id] }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      persisted: true,
      environmentIds: [environment.id],
    });
    expect(
      (
        await db.query.environments.findFirst({
          where: eq(environments.id, environment.id),
        })
      )?.config.manualSkills,
    ).toEqual([skill]);

    // Granting route authentication must not grant mutation authority to a member or owner-only run.
    if (runId !== undefined) {
      await db
        .update(taskRuns)
        .set({ actingUserId: null })
        .where(eq(taskRuns.id, runId));
    } else {
      await db
        .update(users)
        .set({ role: 'member' })
        .where(eq(users.id, admin.id));
    }
    const denied = await app(authContext).request('/api/mcp/custom-skills', {
      method: 'POST',
      body: JSON.stringify({
        ...skill,
        name: 'should-not-save',
        environmentIds: [environment.id],
      }),
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await db.query.environments.findFirst({
          where: eq(environments.id, environment.id),
        })
      )?.config.manualSkills,
    ).toEqual([skill]);
  },
);
