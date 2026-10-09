import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import {
  configureAuthClientEnv,
  createAuthToken,
  createMcpAccessToken,
  getRoomoteMcpResourceUrl,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';
import {
  db,
  deploymentSettings,
  eq,
  fastAgentConversations,
  sessionTasks,
  sessions,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { TaskPayloadKind, type TaskModelOption } from '@roomote/types';
import { createApiApp } from '../../server';

// Prevent inference turns; authentication, creation, persistence and reads stay real.
const { queue } = vi.hoisted(() => ({ queue: vi.fn(async () => true) }));
vi.mock('@roomote/sdk/server', async (original) => ({
  ...(await original<typeof import('@roomote/sdk/server')>()),
  queueFastAgentSurfaceReply: queue,
}));

describe('configured session model API', () => {
  beforeAll(() => {
    const keys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    configureAuthClientEnv({
      jobAuthPrivateKey: Buffer.from(keys.privateKey).toString('base64'),
      jobAuthPublicKey: Buffer.from(keys.publicKey).toString('base64'),
    });
  });
  afterAll(() => configureAuthClientEnv(null));

  it('persists exact public/native selections, refuses invalid choices and reports stored session/run sources', async () => {
    const user = await userFactory.create({ role: 'member' });
    const saved = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
    const models: TaskModelOption[] = [
      {
        id: 'openai/gpt-5.6-luna',
        displayName: 'GPT 5.6 Luna',
        family: 'GPT',
        metadata: {
          contextWindow: null,
          inputTypes: null,
          inputPricePerToken: null,
          outputPricePerToken: null,
          lastRefreshedAt: null,
          supportsReasoning: true,
          supportedReasoningEfforts: ['low', 'high'],
        },
      },
      {
        id: 'anthropic/unknown-efforts',
        displayName: 'Unknown effort support',
        family: 'Claude',
      },
      {
        id: 'openai/no-reasoning',
        displayName: 'No reasoning',
        family: 'GPT',
        metadata: {
          contextWindow: null,
          inputTypes: null,
          inputPricePerToken: null,
          outputPricePerToken: null,
          lastRefreshedAt: null,
          supportsReasoning: false,
        },
      },
      { id: 'openai/disabled-example', displayName: 'Disabled', family: 'GPT' },
    ];
    const taskModelSettings = {
      models,
      allowedModelIds: models.slice(0, 3).map((m) => m.id),
      defaultModelId: models[0]!.id,
    };
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', taskModelSettings })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { taskModelSettings },
      });
    const server = serve({
      fetch: createApiApp().fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP address');
    const base = `http://127.0.0.1:${address.port}`;
    const token = await createAuthToken({ userId: user.id, timeoutMs: 60000 });
    const oauth = await createMcpAccessToken({
      userId: user.id,
      resource: getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
      scopes: [ROOMOTE_MCP_SCOPE],
      timeoutMs: 60000,
    });
    const receipts: unknown[] = [];
    const sessionIds: string[] = [];
    const conversationIds: string[] = [];
    const taskIds: string[] = [];
    async function request(path: string, body?: unknown, bearer = token) {
      const response = await fetch(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const data =
        path === '/mcp' && text.startsWith('event:')
          ? JSON.parse(text.split('data: ')[1]!.split('\n')[0]!)
          : JSON.parse(text);
      receipts.push({
        method: body ? 'POST' : 'GET',
        path,
        request: body ?? null,
        authentication: 'account bearer (omitted)',
        status: response.status,
        body: data,
      });
      return { status: response.status, data };
    }
    try {
      const choice = { model: models[0]!.id, reasoningEffort: 'high' };
      const started = await request('/api/mcp/sessions', {
        message: 'Inspect configured models',
        ...choice,
      });
      expect(started.status).toBe(201);
      sessionIds.push(started.data.sessionId);
      conversationIds.push(started.data.fastConversationId);
      const persisted = await db.query.fastAgentConversations.findFirst({
        where: eq(fastAgentConversations.id, started.data.fastConversationId),
      });
      expect(persisted).toMatchObject(choice);
      const summary = await request(
        `/api/mcp/sessions/${started.data.sessionId}/summary`,
      );
      expect(summary.data.configuredModel).toEqual({
        ...choice,
        modelSource: 'explicit',
        reasoningEffortSource: 'explicit',
      });

      const before = await db.query.fastAgentConversations.findMany({
        where: eq(fastAgentConversations.userId, user.id),
      });
      const queuedBefore = queue.mock.calls.length;
      for (const selection of [
        { model: 'openai/disabled-example' },
        { model: 'not-an-exact-id' },
        { model: ` ${choice.model}` },
        { model: choice.model, reasoningEffort: 'max' },
        { model: choice.model, reasoningEffort: 'turbo' },
        { reasoningEffort: 'high' },
        { model: 'anthropic/unknown-efforts', reasoningEffort: 'high' },
        { model: 'openai/no-reasoning', reasoningEffort: 'high' },
      ])
        expect(
          (
            await request('/api/mcp/sessions', {
              message: 'Refused choice',
              ...selection,
            })
          ).status,
        ).toBe(400);
      expect(queue.mock.calls.length).toBe(queuedBefore);
      expect(
        await db.query.fastAgentConversations.findMany({
          where: eq(fastAgentConversations.userId, user.id),
        }),
      ).toHaveLength(before.length);

      const rpc = await request(
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'manage_tasks',
            arguments: {
              action: 'start',
              message: 'Inspect configured models from MCP',
              ...choice,
            },
          },
        },
        oauth,
      );
      expect(rpc.status).toBe(200);
      expect(rpc.data.result.isError).not.toBe(true);
      const publicStart = JSON.parse(rpc.data.result.content[0].text);
      sessionIds.push(publicStart.sessionId);
      conversationIds.push(publicStart.fastConversationId);
      expect(
        await db.query.fastAgentConversations.findFirst({
          where: eq(fastAgentConversations.id, publicStart.fastConversationId),
        }),
      ).toMatchObject(choice);

      const defaultStart = await request('/api/mcp/sessions', {
        message: 'Use configured defaults',
      });
      sessionIds.push(defaultStart.data.sessionId);
      conversationIds.push(defaultStart.data.fastConversationId);
      const defaultSummary = await request(
        `/api/mcp/sessions/${defaultStart.data.sessionId}/summary`,
      );
      expect(defaultSummary.data.configuredModel).toEqual({
        model: null,
        reasoningEffort: null,
        modelSource: 'default',
        reasoningEffortSource: 'default',
      });

      const task = await taskFactory.create({ initiatorUserId: user.id });
      taskIds.push(task.id);
      await db.insert(sessionTasks).values({
        sessionId: started.data.sessionId,
        taskId: task.id,
        origin: 'fast_delegation',
      });
      await db.insert(taskRuns).values({
        taskId: task.id,
        actingUserId: user.id,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          repo: '',
          description: 'Configured model proof',
          harnessModelOverrides: { 'opencode-server': choice.model },
          reasoningEffort: 'high',
          modelRoleOverrides: { helper: { reasoningEffort: 'low' } },
        },
      });
      const withChild = await request(
        `/api/mcp/sessions/${started.data.sessionId}/summary`,
      );
      expect(withChild.data.tasks[0].latestRun.configuredModels.coding).toEqual(
        summary.data.configuredModel,
      );
      expect(withChild.data.tasks[0].latestRun.configuredModels.helper).toEqual(
        {
          model: null,
          reasoningEffort: 'low',
          modelSource: 'default',
          reasoningEffortSource: 'explicit',
        },
      );
      const taskSummary = await request(`/api/mcp/tasks/${task.id}/summary`);
      expect(taskSummary.data.configuredModels).toEqual(
        withChild.data.tasks[0].latestRun.configuredModels,
      );
      if (process.env.ROOMOTE_MODEL_PROOF_PATH)
        await writeFile(
          process.env.ROOMOTE_MODEL_PROOF_PATH,
          JSON.stringify(
            {
              fixture:
                'Real signed auth and real creation/persistence/read paths over TCP; test catalog. queueFastAgentSurfaceReply stubbed to prevent inference; queued response does not prove actual delivery/execution.',
              receipts,
            },
            null,
            2,
          ),
        );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const id of sessionIds)
        await db.delete(sessions).where(eq(sessions.id, id));
      for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
      for (const id of conversationIds)
        await db
          .delete(fastAgentConversations)
          .where(eq(fastAgentConversations.id, id));
      if (saved)
        await db
          .update(deploymentSettings)
          .set({ taskModelSettings: saved.taskModelSettings })
          .where(eq(deploymentSettings.id, 'default'));
      else
        await db
          .delete(deploymentSettings)
          .where(eq(deploymentSettings.id, 'default'));
      await db.delete(users).where(eq(users.id, user.id));
    }
  }, 30000);
});
