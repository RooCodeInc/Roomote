import { Hono } from 'hono';
import {
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  runFactory,
  taskFactory,
  taskMessages,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import type { FastAgentParent } from '@roomote/types';

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
