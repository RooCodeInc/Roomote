import { Hono } from 'hono';
import {
  automations,
  customAutomations,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  runFactory,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  taskArtifacts,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  type AuthTokenContext,
  type McpAccessTokenContext,
  type RunTokenContext,
} from '@roomote/types';
import type { Variables } from '../types';
import { mcpAuthMiddleware } from './mcp/middleware';
import { searchTasks } from './tasks/searchTasks';
import { getTaskSummary } from './tasks/getTaskSummary';
import { getTaskMessages } from './tasks/getTaskMessages';
import { getTaskRelayUpdates } from './tasks/getRelayUpdates';
import { getTaskComputeLogs } from './tasks/getTaskComputeLogs';
import { sessionsRouter } from './sessions';
import { listTaskArtifacts } from './artifacts/list';
import { getArtifactMetadataByPath } from './artifacts/metadata';
import { getArtifactDownloadUrl } from './artifacts/download-url';

vi.mock('./artifacts/storage', () => ({
  generateDownloadUrl: vi
    .fn()
    .mockResolvedValue('https://example.com/download'),
  resolveArtifactPresignEndpointForRequest: vi.fn(),
}));

function appFor(
  auth: string | AuthTokenContext | McpAccessTokenContext | RunTokenContext,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set(
      'authContext',
      typeof auth === 'string'
        ? { userId: auth, tokenType: 'auth', version: 1 }
        : auth,
    );
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.get('/tasks', searchTasks);
  app.get('/tasks/:taskId/summary', getTaskSummary);
  app.get('/tasks/:taskId/messages', getTaskMessages);
  app.get('/tasks/:taskId/updates', getTaskRelayUpdates);
  app.get('/tasks/:taskId/compute_logs', getTaskComputeLogs);
  app.route('/sessions', sessionsRouter);
  app.get('/tasks/:taskId/artifacts', listTaskArtifacts);
  app.get('/tasks/:taskId/artifacts/:path{.+}', getArtifactMetadataByPath);
  app.get('/artifacts/:id/url', getArtifactDownloadUrl);
  return app;
}

const taskIds: string[] = [];
const sessionIds: string[] = [];
const conversationIds: string[] = [];
const automationIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds.splice(0))
    await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of taskIds.splice(0))
    await db.delete(tasks).where(eq(tasks.id, id));
  for (const id of conversationIds.splice(0))
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, id));
  for (const id of automationIds.splice(0))
    await db.delete(customAutomations).where(eq(customAutomations.id, id));
  for (const id of userIds.splice(0))
    await db.delete(users).where(eq(users.id, id));
});

async function fixture() {
  const owner = await userFactory.create({ role: 'member' });
  const member = await userFactory.create({ role: 'member' });
  const admin = await userFactory.create({ role: 'admin' });
  userIds.push(owner.id, member.id, admin.id);
  await db
    .insert(automations)
    .values({ key: 'custom_automation' })
    .onConflictDoNothing();
  const [automation] = await db
    .insert(customAutomations)
    .values({
      name: `History ${owner.id}`,
      prompt: 'Private automation prompt',
      createdByUserId: owner.id,
    })
    .returning();
  automationIds.push(automation!.id);
  const task = await taskFactory.create({
    title: `Private ${owner.id}`,
    initiatorKind: 'automation',
    initiatorAutomation: 'custom_automation',
    actorExternalId: automation!.id,
    visibility: 'visible',
    workflow: 'standard',
  });
  taskIds.push(task.id);
  return { owner, member, admin, automation: automation!, task };
}

describe('API custom automation history isolation', () => {
  it('filters before pagination and denies every direct task history route to other members', async () => {
    const { owner, member, admin, task } = await fixture();
    for (const suffix of ['summary', 'messages', 'updates', 'compute_logs']) {
      expect(
        (await appFor(member.id).request(`/tasks/${task.id}/${suffix}`)).status,
      ).toBe(404);
      for (const caller of [owner, admin]) {
        expect(
          (await appFor(caller.id).request(`/tasks/${task.id}/${suffix}`))
            .status,
        ).toBe(200);
      }
    }
    for (const caller of [owner, member, admin]) {
      const response = await appFor(caller.id).request(
        `/tasks?query=${owner.id}&limit=1`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tasks.map((row: { id: string }) => row.id)).toEqual(
        caller === member ? [] : [task.id],
      );
      expect(body.hasMore).toBe(false);
    }
    const ordinary = await taskFactory.create({
      title: `Ordinary ${owner.id}`,
      initiatorUserId: owner.id,
      visibility: 'visible',
      activityAt: 1,
    });
    taskIds.push(ordinary.id);
    const page = await (
      await appFor(member.id).request(`/tasks?query=${owner.id}&limit=1`)
    ).json();
    expect(page.tasks.map((row: { id: string }) => row.id)).toEqual([
      ordinary.id,
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('applies the same isolation to user-scoped public MCP authentication contexts', async () => {
    const { owner, member, task } = await fixture();
    for (const caller of [owner, member]) {
      const app = appFor({
        userId: caller.id,
        tokenType: 'mcp',
        version: 1,
        resource: 'https://example.com/mcp',
        scopes: ['roomote'],
      });
      expect((await app.request(`/tasks/${task.id}/messages`)).status).toBe(
        caller === owner ? 200 : 404,
      );
      const results = await (
        await app.request(`/tasks?query=${owner.id}`)
      ).json();
      expect(results.tasks.map((row: { id: string }) => row.id)).toEqual(
        caller === owner ? [task.id] : [],
      );
    }
  });

  it('uses live automation ownership and persisted admin role rather than a token claim', async () => {
    const { owner, member, admin, task, automation } = await fixture();
    const staleAdminApp = appFor(admin.id);
    expect(
      (await staleAdminApp.request(`/tasks/${task.id}/summary`)).status,
    ).toBe(200);
    await db
      .update(users)
      .set({ role: 'member' })
      .where(eq(users.id, admin.id));
    expect(
      (await staleAdminApp.request(`/tasks/${task.id}/summary`)).status,
    ).toBe(404);
    await db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, member.id));
    expect(
      (await appFor(member.id).request(`/tasks/${task.id}/summary`)).status,
    ).toBe(200);
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, member.id));
    expect(
      (await appFor(member.id).request(`/tasks/${task.id}/summary`)).status,
    ).toBe(404);
    await db
      .update(customAutomations)
      .set({ createdByUserId: admin.id })
      .where(eq(customAutomations.id, automation.id));
    expect(
      (await appFor(owner.id).request(`/tasks/${task.id}/summary`)).status,
    ).toBe(404);
    expect(
      (await staleAdminApp.request(`/tasks/${task.id}/summary`)).status,
    ).toBe(200);
  });

  it('fails closed for absent, malformed, deleted and ownerless automation records', async () => {
    const { owner, admin, task, automation } = await fixture();
    await db
      .update(customAutomations)
      .set({ createdByUserId: null })
      .where(eq(customAutomations.id, automation.id));
    expect(
      (await appFor(owner.id).request(`/tasks/${task.id}/messages`)).status,
    ).toBe(404);
    await db
      .delete(customAutomations)
      .where(eq(customAutomations.id, automation.id));
    for (const actorExternalId of [automation.id, null, 'not-a-uuid']) {
      await db
        .update(tasks)
        .set({ actorExternalId })
        .where(eq(tasks.id, task.id));
      expect(
        (await appFor(owner.id).request(`/tasks/${task.id}/messages`)).status,
      ).toBe(404);
      expect(
        (await appFor(admin.id).request(`/tasks/${task.id}/messages`)).status,
      ).toBe(200);
    }
  });

  it('preserves collaborative ordinary history and trusted run-token contracts without bypassing visibility', async () => {
    const { owner, member, task } = await fixture();
    const ordinary = await taskFactory.create({
      initiatorUserId: owner.id,
      visibility: 'visible',
    });
    taskIds.push(ordinary.id);
    expect(
      (await appFor(member.id).request(`/tasks/${ordinary.id}/messages`))
        .status,
    ).toBe(200);
    for (const principal of ['user', 'deployment'] as const) {
      const app = appFor({
        tokenType: 'run',
        principal,
        userId: principal === 'user' ? member.id : null,
        runId: 1,
        version: 1,
      });
      expect((await app.request(`/tasks/${task.id}/messages`)).status).toBe(
        principal === 'user' ? 404 : 200,
      );
    }
    await db
      .update(tasks)
      .set({ visibility: 'hidden' })
      .where(eq(tasks.id, task.id));
    const trusted = appFor({
      tokenType: 'run',
      principal: 'deployment',
      userId: null,
      runId: 1,
      version: 1,
    });
    expect((await trusted.request(`/tasks/${task.id}/messages`)).status).toBe(
      404,
    );
  });

  it('gates human run-token task and Session history by owner and current persisted admin role', async () => {
    const { owner, member, admin, task } = await fixture();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: member.id,
      title: task.title,
    });
    sessionIds.push(session.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    for (const caller of [owner, member, admin]) {
      const app = appFor({
        tokenType: 'run',
        principal: 'user',
        userId: caller.id,
        runId: 1,
        version: 1,
      });
      for (const suffix of ['summary', 'messages', 'updates', 'compute_logs']) {
        expect((await app.request(`/tasks/${task.id}/${suffix}`)).status).toBe(
          caller === member ? 404 : 200,
        );
      }
      for (const suffix of ['summary', 'messages', 'updates']) {
        expect(
          (await app.request(`/sessions/${session.id}/${suffix}`)).status,
        ).toBe(caller === member ? 404 : 200);
      }
      const search = await (
        await app.request(`/tasks?query=${owner.id}`)
      ).json();
      expect(search.tasks.map((row: { id: string }) => row.id)).toEqual(
        caller === member ? [] : [task.id],
      );
    }
    const app = appFor({
      tokenType: 'run',
      principal: 'user',
      userId: admin.id,
      runId: 1,
      version: 1,
    });
    await db
      .update(users)
      .set({ role: 'member' })
      .where(eq(users.id, admin.id));
    expect((await app.request(`/tasks/${task.id}/messages`)).status).toBe(404);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id));
    expect((await app.request(`/tasks/${task.id}/messages`)).status).toBe(200);
  });

  it('restricts artifact history and URL issuance for human runs while retaining deployment and ordinary reads', async () => {
    const { owner, member, admin, task } = await fixture();
    const ordinary = await taskFactory.create({
      initiatorUserId: member.id,
      visibility: 'visible',
    });
    taskIds.push(ordinary.id);
    const run = await runFactory.create({ taskId: ordinary.id });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        path: 'report.txt',
        version: 1,
        contentType: 'text/plain',
        uploaded: true,
        size: 1,
      })
      .returning();
    const urls = [
      `/tasks/${task.id}/artifacts`,
      `/tasks/${task.id}/artifacts/report.txt`,
      `/artifacts/${artifact!.id}/url?taskId=${task.id}`,
    ];
    for (const caller of [owner, member, admin, null]) {
      const app = appFor({
        tokenType: 'run',
        principal: caller ? 'user' : 'deployment',
        userId: caller?.id ?? null,
        runId: run.id,
        version: 1,
      });
      for (const url of urls)
        expect((await app.request(url)).status).toBe(
          caller === member ? 403 : 200,
        );
      expect(
        (await app.request(`/tasks/${ordinary.id}/artifacts`)).status,
      ).toBe(200);
    }
    const adminApp = appFor({
      tokenType: 'run',
      principal: 'user',
      userId: admin.id,
      runId: run.id,
      version: 1,
    });
    await db
      .update(users)
      .set({ role: 'member' })
      .where(eq(users.id, admin.id));
    for (const url of urls)
      expect((await adminApp.request(url)).status).toBe(403);
    // A run binding does not override another person's automation ownership.
    const automationRun = await runFactory.create({ taskId: task.id });
    const memberApp = appFor({
      tokenType: 'run',
      principal: 'user',
      userId: member.id,
      runId: automationRun.id,
      version: 1,
    });
    for (const url of urls)
      expect((await memberApp.request(url)).status).toBe(403);
    await db
      .update(tasks)
      .set({ visibility: 'hidden' })
      .where(eq(tasks.id, task.id));
    for (const boundRun of [run, automationRun]) {
      const deploymentApp = appFor({
        tokenType: 'run',
        principal: 'deployment',
        userId: null,
        runId: boundRun.id,
        version: 1,
      });
      for (const url of urls)
        expect((await deploymentApp.request(url)).status).toBe(
          boundRun === automationRun ? 200 : 403,
        );
    }
  });

  it('protects task-linked unified Sessions even when the member owns the Session', async () => {
    const { owner, member, admin, task } = await fixture();
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: member.id,
      title: task.title,
    });
    sessionIds.push(session.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'direct_launch',
    });
    for (const suffix of ['summary', 'messages', 'updates']) {
      expect(
        (await appFor(member.id).request(`/sessions/${session.id}/${suffix}`))
          .status,
      ).toBe(404);
      for (const caller of [owner, admin]) {
        const response = await appFor(caller.id).request(
          `/sessions/${session.id}/${suffix}`,
        );
        expect(response.status).toBe(200);
      }
    }
    for (const caller of [owner, member, admin]) {
      const response = await appFor(caller.id).request(
        `/sessions?query=${owner.id}`,
      );
      const body = await response.json();
      expect(body.sessions.map((row: { id: string }) => row.id)).toEqual(
        caller === member ? [] : [session.id],
      );
      if (caller !== member)
        expect(body.sessions[0].tasks[0].taskId).toBe(task.id);
    }
  });

  it.each([
    'event',
    'prompt',
    'occurrence',
    'surface',
    'task',
    'legacy-task',
  ] as const)(
    'protects Fast %s provenance through canonical, alternate and legacy task-message routes',
    async (provenance) => {
      const { owner, member, admin, task, automation } = await fixture();
      const [conversation] = await db
        .insert(fastAgentConversations)
        .values({
          userId: member.id,
          surface: provenance === 'surface' ? 'automation' : 'web',
          workspaceId: provenance === 'surface' ? automation.id : member.id,
          conversationId:
            provenance === 'occurrence'
              ? `${automation.id}:${new Date().toISOString()}`
              : crypto.randomUUID(),
        })
        .returning();
      conversationIds.push(conversation!.id);
      const session = await sessionFactory.create({
        ownerKind: 'user',
        ownerUserId: member.id,
        fastConversationId: conversation!.id,
        title: `Fast ${owner.id}`,
      });
      sessionIds.push(session.id);
      const event = {
        type: 'automation_triggered' as const,
        automationId: automation.id,
      };
      if (provenance === 'event') {
        await db.insert(fastAgentParentEvents).values({
          conversationId: conversation!.id,
          eventKey: crypto.randomUUID(),
          parent: {
            sessionId: conversation!.id,
            conversation: {
              surface: 'automation',
              workspaceId: automation.id,
              conversationId: conversation!.conversationId,
            },
          },
          event,
        });
      } else if (provenance === 'prompt') {
        await db.insert(fastAgentMessages).values({
          conversationId: conversation!.id,
          eventId: crypto.randomUUID(),
          turnId: 'automation',
          turnSeq: 0,
          ts: 1,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          source: 'web',
          payload: {},
          metadata: {
            turnSource: 'platform_event',
            platformEventKind: 'automation',
            visibleInTranscript: false,
          },
          contentBlocks: [
            {
              type: 'text',
              text: `<platform_event>${JSON.stringify(event)}</platform_event>`,
            },
          ],
        });
      } else if (provenance === 'task' || provenance === 'legacy-task') {
        const legacyId = crypto.randomUUID();
        if (provenance === 'legacy-task')
          await db
            .update(fastAgentConversations)
            .set({ legacyConversationIds: [legacyId] })
            .where(eq(fastAgentConversations.id, conversation!.id));
        await runFactory.create({
          taskId: task.id,
          payload: {
            fastAgentSessionId:
              provenance === 'legacy-task' ? legacyId : conversation!.id,
          },
        });
      }
      for (const caller of [owner, member, admin]) {
        const app = appFor(caller.id);
        const expected = caller === member ? 404 : 200;
        for (const id of [session.id, conversation!.id]) {
          for (const suffix of ['summary', 'messages', 'updates']) {
            expect(
              (await app.request(`/sessions/${id}/${suffix}`)).status,
            ).toBe(expected);
          }
        }
        expect(
          (await app.request(`/tasks/${conversation!.id}/messages`)).status,
        ).toBe(expected);
        const result = await (
          await app.request(`/sessions?query=${owner.id}`)
        ).json();
        expect(result.sessions.map((row: { id: string }) => row.id)).toEqual(
          caller === member ? [] : [session.id],
        );
      }
      for (const caller of [owner, member]) {
        const humanRunApp = appFor({
          tokenType: 'run',
          principal: 'user',
          userId: caller.id,
          runId: 1,
          version: 1,
        });
        for (const url of [
          `/tasks/${conversation!.id}/messages`,
          `/sessions/${conversation!.id}/summary`,
        ]) {
          expect((await humanRunApp.request(url)).status).toBe(
            caller === owner ? 200 : 404,
          );
        }
      }
      // Removing configuration never turns historical private provenance public.
      await db
        .delete(customAutomations)
        .where(eq(customAutomations.id, automation.id));
      expect(
        (await appFor(owner.id).request(`/sessions/${session.id}/summary`))
          .status,
      ).toBe(404);
    },
  );

  it('denies Fast alternate-ID backfill before creating a canonical Session for a non-owner', async () => {
    const { owner, member, automation } = await fixture();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: member.id,
        surface: 'automation',
        workspaceId: automation.id,
        conversationId: crypto.randomUUID(),
      })
      .returning();
    conversationIds.push(conversation!.id);
    expect(
      (await appFor(member.id).request(`/sessions/${conversation!.id}/summary`))
        .status,
    ).toBe(404);
    expect(
      await db.query.sessions.findFirst({
        where: eq(sessions.fastConversationId, conversation!.id),
      }),
    ).toBeUndefined();
    const response = await appFor(owner.id).request(
      `/sessions/${conversation!.id}/summary`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    sessionIds.push(body.id);
  });
});
