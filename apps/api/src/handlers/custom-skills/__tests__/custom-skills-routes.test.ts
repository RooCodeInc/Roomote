import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  db,
  environmentFactory,
  environments,
  eq,
  runFactory,
  taskFactory,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';
import { CREATE_SKILL_TOOL, type CreateSkillInput } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { registerRoomoteCreateSkillTool } from '../../mcp/roomote-create-skill-tool';
import { customSkillsRouter } from '../index';

const skill = {
  name: 'deploy-check',
  description: 'Check deployment',
  content: 'Run the checks.\n',
};

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((_error, c) => c.json({ error: 'internal_server_error' }, 500));
  app.use('*', async (c, next) => {
    if (authContext) c.set('authContext', authContext);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.route('/api/mcp/custom-skills', customSkillsRouter);
  return app;
}

function post(
  auth: AuthTokenContext | RunTokenContext | undefined,
  body: unknown,
) {
  return createApp(auth).request(
    'https://untrusted.example/api/mcp/custom-skills',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'untrusted.example',
      },
      body: JSON.stringify(body),
    },
  );
}

describe('custom-skills authenticated API', () => {
  const userIds: string[] = [];
  const environmentIds: string[] = [];
  const taskIds: string[] = [];

  async function createUser(
    overrides: Parameters<typeof userFactory.create>[0] = {},
  ) {
    const user = await userFactory.create({ role: 'admin', ...overrides });
    userIds.push(user.id);
    return user;
  }

  async function createEnvironment(
    overrides: Parameters<typeof environmentFactory.create>[0] = {},
  ) {
    const environment = await environmentFactory.create({
      userId: null,
      createdByUserId: null,
      config: {
        name: 'Skill route test',
        repositories: [{ repository: 'test/repo' }],
      },
      ...overrides,
    });
    environmentIds.push(environment.id);
    return environment;
  }

  function userToken(userId: string): AuthTokenContext {
    return { userId, tokenType: 'auth', version: 1 };
  }

  async function runToken(
    actingUserId: string | null,
    mintUserId: string | null,
  ): Promise<RunTokenContext> {
    const task = await taskFactory.create({ initiatorUserId: mintUserId });
    taskIds.push(task.id);
    const run = await runFactory.create({ taskId: task.id, actingUserId });
    return {
      runId: run.id,
      userId: mintUserId,
      principal: mintUserId ? 'user' : 'deployment',
      tokenType: 'run',
      version: 1,
    };
  }

  async function config(id: string) {
    return (
      await db.query.environments.findFirst({ where: eq(environments.id, id) })
    )?.config;
  }

  function registeredTool(authContext: AuthTokenContext | RunTokenContext) {
    let handler: ((params: CreateSkillInput) => Promise<unknown>) | undefined;
    const registerTool = vi.fn(
      (_name: string, _config: unknown, callback: typeof handler) => {
        handler = callback;
      },
    );
    registerRoomoteCreateSkillTool({ registerTool } as unknown as McpServer, {
      userId: authContext.userId ?? undefined,
      authContext,
    });
    expect(registerTool).toHaveBeenCalledExactlyOnceWith(
      CREATE_SKILL_TOOL.name,
      {
        title: CREATE_SKILL_TOOL.title,
        description: CREATE_SKILL_TOOL.description,
        inputSchema: CREATE_SKILL_TOOL.inputSchema,
        annotations: CREATE_SKILL_TOOL.annotations,
      },
      expect.any(Function),
    );
    return handler!;
  }

  it.each(['user-admin', 'run-admin', 'run-member'] as const)(
    'dispatches API-hosted create_skill through the authorized route: %s',
    async (kind) => {
      const admin = await createUser();
      const member = await createUser({ role: 'member' });
      const auth =
        kind === 'user-admin'
          ? userToken(admin.id)
          : await runToken(
              kind === 'run-admin' ? admin.id : member.id,
              admin.id,
            );
      const environment = await createEnvironment();
      const invoke = registeredTool(auth);
      const result = await invoke({
        ...skill,
        environmentIds: [environment.id],
      });
      if (kind === 'run-member') {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: 'Admin access required', status: 403 },
        });
        expect(await config(environment.id)).toEqual(environment.config);
      } else {
        expect(result).toMatchObject({
          structuredContent: {
            success: true,
            name: skill.name,
            invocation: '$deploy-check',
            updatedEnvironmentIds: [environment.id],
            settingsUrl: new URL('/settings/skills', Env.R_APP_URL).toString(),
          },
        });
        expect((await config(environment.id))?.manualSkills).toEqual([skill]);
        const duplicate = await invoke({
          ...skill,
          environmentIds: [environment.id],
        });
        expect(duplicate).toMatchObject({
          isError: true,
          structuredContent: {
            status: 400,
            error: expect.stringContaining('already has a manual skill'),
          },
        });
        expect((await config(environment.id))?.manualSkills).toEqual([skill]);
      }
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of taskIds.splice(0))
      await db.delete(tasks).where(eq(tasks.id, id));
    for (const id of environmentIds.splice(0))
      await db.delete(environments).where(eq(environments.id, id));
    for (const id of userIds.splice(0))
      await db.delete(users).where(eq(users.id, id));
  });

  it('creates in selected environments only, deduplicates IDs, and returns authoritative metadata', async () => {
    const admin = await createUser();
    const first = await createEnvironment();
    const second = await createEnvironment();
    const untouched = await createEnvironment();
    const response = await post(userToken(admin.id), {
      ...skill,
      description: ` ${skill.description} `,
      environmentIds: [first.id, second.id, first.id.toUpperCase()],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      skillId: expect.stringMatching(/^manual@deploy-check#[a-f0-9]{12}$/),
      updatedEnvironmentIds: [first.id, second.id].sort(),
      name: skill.name,
      invocation: '$deploy-check',
      settingsUrl: new URL('/settings/skills', Env.R_APP_URL).toString(),
      note: 'Available to new tasks in the selected environments. The current session is not updated.',
    });
    expect((await config(first.id))?.manualSkills).toEqual([skill]);
    expect((await config(second.id))?.manualSkills).toEqual([skill]);
    expect(await config(untouched.id)).toEqual(untouched.config);
  });

  it.each(['member', 'deleted', 'missing', 'unauthenticated'] as const)(
    'rejects %s users without writing',
    async (kind) => {
      const user = await createUser({
        role: kind === 'member' ? 'member' : 'admin',
        deletedAt: kind === 'deleted' ? new Date() : null,
      });
      const environment = await createEnvironment();
      const auth =
        kind === 'unauthenticated'
          ? undefined
          : userToken(kind === 'missing' ? randomUUID() : user.id);
      const response = await post(auth, {
        ...skill,
        environmentIds: [environment.id],
      });
      expect(response.status).toBe(kind === 'unauthenticated' ? 401 : 403);
      expect(await config(environment.id)).toEqual(environment.config);
    },
  );

  it.each([
    'deployment-admin',
    'member-minted-admin',
    'admin-minted-member',
    'no-actor',
    'deleted-actor',
    'missing-run',
  ] as const)('uses live run identity: %s', async (kind) => {
    const admin = await createUser();
    const member = await createUser({ role: 'member' });
    const deleted = await createUser({ deletedAt: new Date() });
    const actor =
      kind === 'admin-minted-member'
        ? member.id
        : kind === 'no-actor'
          ? null
          : kind === 'deleted-actor'
            ? deleted.id
            : admin.id;
    const auth = await runToken(
      actor,
      kind === 'deployment-admin'
        ? null
        : kind === 'member-minted-admin'
          ? member.id
          : admin.id,
    );
    if (kind === 'missing-run') auth.runId = 2147483647;
    const environment = await createEnvironment();
    const response = await post(auth, {
      ...skill,
      environmentIds: [environment.id],
    });
    const allowed =
      kind === 'deployment-admin' || kind === 'member-minted-admin';
    expect(response.status).toBe(allowed ? 201 : 403);
    expect(await config(environment.id)).toEqual(
      allowed
        ? { ...environment.config, manualSkills: [skill] }
        : environment.config,
    );
  });

  it.each([
    { environmentIds: undefined },
    { environmentIds: [] },
    { environmentIds: ['invalid'] },
    { environmentIds: ['__all_repositories__'] },
    { name: '../invalid' },
    { description: ' ' },
    { content: ' ' },
    { previousSkillId: 'manual@existing#123' },
    { overwrite: true },
    { unexpected: true },
  ])('rejects invalid or non-create input %j', async (override) => {
    const admin = await createUser();
    const environment = await createEnvironment();
    const response = await post(userToken(admin.id), {
      ...skill,
      environmentIds: [environment.id],
      ...override,
    });
    expect(response.status).toBe(400);
    expect(await config(environment.id)).toEqual(environment.config);
  });

  it('rejects malformed JSON', async () => {
    const admin = await createUser();
    const response = await createApp(userToken(admin.id)).request(
      '/api/mcp/custom-skills',
      { method: 'POST', body: 'not-json' },
    );
    expect(response.status).toBe(400);
  });

  it.each(['missing', 'private', 'eval', 'duplicate'] as const)(
    'atomically rejects %s selected environments with a safe validation error',
    async (kind) => {
      const admin = await createUser();
      const first = await createEnvironment();
      const other =
        kind === 'missing'
          ? { id: randomUUID() }
          : await createEnvironment({
              ...(kind === 'private' ? { userId: admin.id } : {}),
              ...(kind === 'eval' ? { isEval: true } : {}),
              ...(kind === 'duplicate'
                ? { config: { ...first.config, manualSkills: [skill] } }
                : {}),
            });
      const before = await config(other.id);
      const response = await post(userToken(admin.id), {
        ...skill,
        environmentIds: [first.id, other.id],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          kind === 'duplicate'
            ? 'A selected environment already has a manual skill named "deploy-check".'
            : 'Selected environments must belong to this deployment.',
      });
      expect(await config(first.id)).toEqual(first.config);
      expect(await config(other.id)).toEqual(before);
    },
  );

  it('fails closed when actor lookup fails', async () => {
    const admin = await createUser();
    const auth = await runToken(admin.id, admin.id);
    const environment = await createEnvironment();
    vi.spyOn(db.query.taskRuns, 'findFirst').mockRejectedValueOnce(
      new Error('private failure'),
    );
    const response = await post(auth, {
      ...skill,
      environmentIds: [environment.id],
    });
    expect(response.status).toBe(403);
    expect(await config(environment.id)).toEqual(environment.config);
  });

  it('fails closed without exposing unexpected database failures', async () => {
    const admin = await createUser();
    const environment = await createEnvironment();
    vi.spyOn(db.query.users, 'findFirst').mockRejectedValueOnce(
      new Error('private database details'),
    );
    const response = await post(userToken(admin.id), {
      ...skill,
      environmentIds: [environment.id],
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_server_error' });
    expect(await config(environment.id)).toEqual(environment.config);
  });
});
