import { Hono } from 'hono';
import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';
import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
vi.mock('@roomote/telemetry/server', () => ({ captureTaskSettled: vi.fn() }));
vi.mock('@roomote/sdk/server', () => ({
  settleLiveTaskMessageOnExit: vi.fn().mockResolvedValue(undefined),
}));
import { cancelTask } from '../cancelTask';

it('cancels the newest run when run creation timestamps tie', async () => {
  const task = await taskFactory.create({ title: 'Cancel ordering probe' });
  try {
    const [older, latest] = await db.transaction(async (tx) => {
      const factory = runFactory.transient({ db: tx });
      return [
        await factory.create({
          taskId: task.id,
          status: RunStatus.Completed,
          completedAt: new Date(),
        }),
        await factory.create({ taskId: task.id, status: RunStatus.Running }),
      ] as const;
    });
    expect(older!.createdAt.getTime()).toBe(latest!.createdAt.getTime());
    const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
    app.post('/tasks/:taskId/cancel', cancelTask);
    const response = await app.request(`/tasks/${task.id}/cancel`, {
      method: 'POST',
    });
    const persistedLatest = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, latest.id),
    });
    const persistedOlder = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, older.id),
    });
    expect(response.status).toBe(200);
    expect(persistedLatest?.status).toBe(RunStatus.Canceled);
    expect(persistedLatest?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(persistedLatest?.canceledAt).toBeInstanceOf(Date);
    expect(persistedOlder?.status).toBe(RunStatus.Completed);
    const repeated = await app.request(`/tasks/${task.id}/cancel`, {
      method: 'POST',
    });
    expect(repeated.status).toBe(409);
    const afterRepeated = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, latest.id),
    });
    expect(afterRepeated?.canceledAt?.toISOString()).toBe(
      persistedLatest?.canceledAt?.toISOString(),
    );
  } finally {
    await db.delete(tasks).where(eq(tasks.id, task.id));
  }
});

it('preserves creation time as primary order when a higher-ID run is backdated', async () => {
  const task = await taskFactory.create({
    title: 'Cancel chronology regression',
  });
  try {
    const chronologicalLatest = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
    });
    const higherId = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Completed,
      completedAt: new Date(),
    });
    await db
      .update(taskRuns)
      .set({
        createdAt: new Date(chronologicalLatest.createdAt.getTime() - 1000),
      })
      .where(eq(taskRuns.id, higherId.id));
    const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
    app.post('/tasks/:taskId/cancel', cancelTask);
    const response = await app.request(`/tasks/${task.id}/cancel`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(
      (
        await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, chronologicalLatest.id),
        })
      )?.status,
    ).toBe(RunStatus.Canceled);
    expect(
      (
        await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, higherId.id),
        })
      )?.status,
    ).toBe(RunStatus.Completed);
  } finally {
    await db.delete(tasks).where(eq(tasks.id, task.id));
  }
});
