import { Hono } from 'hono';
import {
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  runFactory,
  taskFactory,
  taskMessages,
  taskRuns,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { RunStatus, type FastAgentParent } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import { getTaskSummary } from '../getTaskSummary';

vi.mock('../../artifacts/service', () => ({
  listArtifactsByTask: vi.fn().mockResolvedValue([]),
}));

describe('getTaskSummary durable parent reports', () => {
  const taskIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    while (taskIds.length) {
      await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
    }
    // User deletion cascades to the owned conversations and their parent events.
    while (userIds.length) {
      await db.delete(users).where(eq(users.id, userIds.pop()!));
    }
  });

  it.each([
    { purpose: 'progress', detail: 'The usage limit has been reached' },
    { purpose: 'closeout', detail: 'Insufficient credits' },
  ])(
    'reconciles a resumable completed run after quota exhaustion ($purpose)',
    async ({ purpose, detail }) => {
      const user = await userFactory.create();
      userIds.push(user.id);
      const task = await taskFactory.create({
        initiatorUserId: user.id,
        state: 'completed',
      });
      taskIds.push(task.id);
      const conversation = {
        surface: 'web' as const,
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      };
      const [parentConversation] = await db
        .insert(fastAgentConversations)
        .values({ userId: user.id, ...conversation })
        .returning();
      const parent: FastAgentParent = {
        sessionId: parentConversation!.id,
        conversation,
      };
      const payload = {
        repo: 'test/repo',
        description: 'Terminal provider error regression',
        fastAgentParent: parent,
      };
      const run = await runFactory.create({
        taskId: task.id,
        actingUserId: user.id,
        status: RunStatus.Completed,
        error: null,
        payload,
      });
      const at = (seconds: number) =>
        new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
      const addReport = (
        seconds: number,
        runId: number,
        reportPurpose: string,
      ) =>
        db.insert(fastAgentParentEvents).values({
          conversationId: parent.sessionId,
          eventKey: crypto.randomUUID(),
          parent,
          event: {
            type: 'child_message',
            taskId: task.id,
            runId,
            purpose: reportPurpose,
            messageId: crypto.randomUUID(),
            message: `Implementation report at ${seconds}`,
          },
          createdAt: at(seconds),
        });
      const addMessage = (
        seconds: number,
        data: Record<string, unknown>,
        messageTaskId = task.id,
        runId = run.id,
      ) =>
        db.insert(taskMessages).values({
          taskId: messageTaskId,
          runId,
          ts: at(seconds).getTime(),
          protocol: 'roomote_runtime',
          eventType: 'roomote_runtime.assistant_message',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: detail }],
          metadata: { visibleInTranscript: true, ...data },
          payload: data,
          createdAt: at(seconds),
        });
      const app = new Hono<{ Variables: Variables }>();
      app.use('*', async (c, next) => {
        c.set('authContext', {
          userId: user.id,
          tokenType: 'auth',
          version: 1,
        });
        await next();
      });
      app.use('*', mcpAuthMiddleware);
      app.get('/tasks/:taskId/summary', getTaskSummary);
      const summary = async () => {
        const response = await app.request(`/tasks/${task.id}/summary`);
        expect(response.status).toBe(200);
        return response.json();
      };

      // A transient retry followed by a report is not a terminal failure.
      await addMessage(0, {
        providerRetryNotice: {
          kind: 'rate_limit',
          attemptNumber: 1,
          maxAttempts: 3,
        },
      });
      await addReport(1, run.id, purpose);
      expect(await summary()).toMatchObject({
        completed: true,
        taskRunStatus: RunStatus.Completed,
        summary: 'Implementation report at 1',
        taskRunError: null,
      });

      // A different task's parent failure must not erase this child's outcome.
      const otherTask = await taskFactory.create({
        initiatorUserId: user.id,
        state: 'completed',
      });
      taskIds.push(otherTask.id);
      const otherRun = await runFactory.create({
        taskId: otherTask.id,
        status: RunStatus.Completed,
        error: null,
      });
      const terminal = { terminalProviderError: { errorSummary: detail } };
      await addMessage(2, terminal, otherTask.id, otherRun.id);
      expect((await summary()).summary).toBe('Implementation report at 1');
      const parentResponse = await app.request(
        `/tasks/${otherTask.id}/summary`,
      );
      expect(parentResponse.status).toBe(200);
      expect(await parentResponse.json()).toMatchObject({
        summary: null,
        taskRunError: detail,
        taskRunStatus: RunStatus.Completed,
      });

      // This mirrors the canonical envelope emitted after retry exhaustion.
      await addMessage(3, terminal);
      const blocked = await summary();
      expect(blocked).toMatchObject({
        completed: true,
        taskRunStatus: RunStatus.Completed,
        summary: null,
        taskRunError: detail,
      });
      expect(await summary()).toEqual(blocked);
      expect(
        await db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run.id) }),
      ).toMatchObject({ status: RunStatus.Completed, error: null });
      expect(
        await db.query.fastAgentParentEvents.findMany({
          where: eq(fastAgentParentEvents.conversationId, parent.sessionId),
        }),
      ).toHaveLength(1);

      // Progress after a resumed turn is not evidence of successful completion.
      await addReport(4, run.id, 'progress');
      expect(await summary()).toMatchObject({
        summary: null,
        taskRunError: detail,
      });
      await addReport(5, run.id, 'closeout');
      expect(await summary()).toMatchObject({
        summary: 'Implementation report at 5',
        taskRunError: null,
      });

      // A new attempt's failure wins over any report from the previous attempt.
      const nextRun = await runFactory.create({
        taskId: task.id,
        actingUserId: user.id,
        status: RunStatus.Completed,
        error: null,
        payload,
      });
      await addMessage(6, terminal, task.id, nextRun.id);
      await addReport(7, run.id, 'closeout');
      expect(await summary()).toMatchObject({
        summary: null,
        taskRunError: detail,
      });

      // A newer successful attempt supersedes the old blocker without writes.
      const successfulRun = await runFactory.create({
        taskId: task.id,
        actingUserId: user.id,
        status: RunStatus.Completed,
        error: null,
        payload,
      });
      await addReport(8, successfulRun.id, 'closeout');
      const recovered = await summary();
      expect(recovered).toMatchObject({
        completed: true,
        taskRunStatus: RunStatus.Completed,
        summary: 'Implementation report at 8',
        taskRunError: null,
      });
      expect(await summary()).toEqual(recovered);
      expect(
        await db.query.fastAgentParentEvents.findMany({
          where: eq(fastAgentParentEvents.conversationId, parent.sessionId),
        }),
      ).toHaveLength(5);
    },
  );

  it.each([true, false])(
    'returns only the durable report (hasReport=%s)',
    async (hasReport) => {
      const user = await userFactory.create();
      userIds.push(user.id);
      const task = await taskFactory.create({ initiatorUserId: user.id });
      taskIds.push(task.id);
      const otherTask = await taskFactory.create({ initiatorUserId: user.id });
      taskIds.push(otherTask.id);
      const conversation = {
        surface: 'web' as const,
        workspaceId: user.id,
        conversationId: crypto.randomUUID(),
      };
      const [parentConversation] = await db
        .insert(fastAgentConversations)
        .values({ userId: user.id, ...conversation })
        .returning();
      const parent: FastAgentParent = {
        sessionId: parentConversation!.id,
        conversation,
      };
      const run = await runFactory.create({
        taskId: task.id,
        actingUserId: user.id,
        payload: {
          repo: 'test/repo',
          description: 'Report regression',
          fastAgentParent: parent,
        },
      });
      const report =
        'Implemented the fix.\nValidation: focused regression passed.';
      const at = (seconds: number) =>
        new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
      const reportEvent = {
        type: 'child_message',
        taskId: task.id,
        runId: run.id,
        purpose: 'closeout',
        messageId: crypto.randomUUID(),
        message: report,
      };
      const addEvent = (seconds: number, overrides: Record<string, unknown>) =>
        db.insert(fastAgentParentEvents).values({
          conversationId: parent.sessionId,
          eventKey: crypto.randomUUID(),
          parent,
          event: { ...reportEvent, ...overrides },
          createdAt: at(seconds),
        });
      if (hasReport) {
        await addEvent(0, { message: 'Superseded report' });
        await addEvent(1, {});
      }
      await addEvent(5, { type: 'child_settled', message: 'Non-report event' });
      await addEvent(6, { taskId: otherTask.id, message: 'Other task report' });
      await db.insert(taskMessages).values(
        [
          'Ordinary assistant narrative after the report.',
          'I will start the requested work now.',
          'Draft pull request opened: https://github.com/example/repo/pull/1',
        ].map((text, index) => ({
          taskId: task.id,
          runId: run.id,
          ts: index + 2,
          protocol: 'roomote_runtime' as const,
          eventType: 'roomote_runtime.assistant_message' as const,
          role: 'assistant' as const,
          contentBlocks: [{ type: 'text' as const, text }],
          metadata: { visibleInTranscript: true },
          payload: {},
          createdAt: at(index + 2),
        })),
      );

      const app = new Hono<{ Variables: Variables }>();
      app.use('*', async (c, next) => {
        c.set('authContext', {
          userId: user.id,
          tokenType: 'auth',
          version: 1,
        });
        await next();
      });
      app.use('*', mcpAuthMiddleware);
      app.get('/tasks/:taskId/summary', getTaskSummary);
      const response = await app.request(`/tasks/${task.id}/summary`);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.summary).toBe(hasReport ? report : null);
    },
  );
});
