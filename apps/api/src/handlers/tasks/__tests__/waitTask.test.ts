import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';

const {
  scheduleTaskWait,
  clearTaskWaitSchedule,
  enqueueTaskWake,
  removeTaskWake,
  scheduleTaskSleep,
} = vi.hoisted(() => ({
  scheduleTaskWait: vi.fn(),
  clearTaskWaitSchedule: vi.fn(),
  enqueueTaskWake: vi.fn(),
  removeTaskWake: vi.fn(),
  scheduleTaskSleep: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  scheduleTaskWait,
  clearTaskWaitSchedule,
}));
vi.mock('@roomote/sdk/server', () => ({
  enqueueTaskWake,
  removeTaskWake,
  scheduleTaskSleep,
}));

import { waitTask } from '../waitTask';

function createApp(runId = 42) {
  const app = new Hono<{ Variables: Variables & { mcpAuth: McpAuth } }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', { userId: undefined, authContext: { runId } as never });
    await next();
  });
  app.post('/runs/:runId/wait', waitTask);
  return app;
}

describe('wait task API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueTaskWake.mockReset().mockResolvedValue(undefined);
    removeTaskWake.mockReset().mockResolvedValue(undefined);
    scheduleTaskSleep.mockReset().mockResolvedValue(undefined);
  });

  it('schedules the wake before the resumable sleep', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    scheduleTaskWait.mockResolvedValue({ scheduled: true, waitUntil });

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskWake).toHaveBeenCalledWith({
      runId: 42,
      waitUntil: waitUntil.toISOString(),
    });
    expect(scheduleTaskSleep).toHaveBeenCalledWith({ runId: 42 });
    expect(enqueueTaskWake.mock.invocationCallOrder[0]).toBeLessThan(
      scheduleTaskSleep.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects waits shorter than the sleep handoff minimum', async () => {
    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 60, reason: 'Too soon' }),
    });

    expect(response.status).toBe(400);
    expect(scheduleTaskWait).not.toHaveBeenCalled();
  });

  it('removes the wake and clears the DB schedule when sleep queueing fails', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    const goalRollback = {
      taskId: 'task-1',
      expectedGeneration: 'goal-generation:wait',
      previousLastContinuationId: 'goal-generation:current',
      previousGenerationIds: ['goal-generation:current'],
    };
    scheduleTaskWait.mockResolvedValue({
      scheduled: true,
      waitUntil,
      goalRollback,
    });
    scheduleTaskSleep.mockRejectedValue(new Error('redis unavailable'));

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(500);
    expect(removeTaskWake).toHaveBeenCalledWith(42);
    expect(clearTaskWaitSchedule).toHaveBeenCalledWith({
      runId: 42,
      waitUntil,
      goalRollback,
    });
  });

  it('repairs queue side effects and succeeds when retrying an existing wait', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    scheduleTaskWait.mockResolvedValue({
      scheduled: false,
      reason: 'already_waiting',
      waitUntil,
      sleepRequired: true,
    });

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduled: true,
      alreadyScheduled: true,
      waitUntil: waitUntil.toISOString(),
    });
    expect(enqueueTaskWake).toHaveBeenCalledWith({
      runId: 42,
      waitUntil: waitUntil.toISOString(),
    });
    expect(scheduleTaskSleep).toHaveBeenCalledWith({ runId: 42 });
  });

  it('does not reschedule sleep when retrying after the task is already asleep', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    scheduleTaskWait.mockResolvedValue({
      scheduled: false,
      reason: 'already_waiting',
      waitUntil,
      sleepRequired: false,
    });

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(200);
    expect(enqueueTaskWake).toHaveBeenCalledOnce();
    expect(scheduleTaskSleep).not.toHaveBeenCalled();
  });

  it('preserves an existing durable wait when retry repair cannot reach Redis', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    scheduleTaskWait.mockResolvedValue({
      scheduled: false,
      reason: 'already_waiting',
      waitUntil,
      sleepRequired: false,
    });
    enqueueTaskWake.mockRejectedValueOnce(new Error('redis unavailable'));

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(500);
    expect(clearTaskWaitSchedule).not.toHaveBeenCalled();
    expect(removeTaskWake).not.toHaveBeenCalled();
  });

  it('rejects retries after the wait has already been consumed', async () => {
    scheduleTaskWait.mockResolvedValue({
      scheduled: false,
      reason: 'already_resumed',
      waitUntil: new Date('2026-08-13T16:00:00.000Z'),
    });

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(409);
    expect(enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('clears the DB schedule even when Redis wake cleanup fails', async () => {
    const waitUntil = new Date('2026-08-13T16:00:00.000Z');
    scheduleTaskWait.mockResolvedValue({ scheduled: true, waitUntil });
    scheduleTaskSleep.mockRejectedValue(new Error('redis unavailable'));
    removeTaskWake.mockRejectedValue(new Error('redis still unavailable'));

    const response = await createApp().request('/runs/42/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 1_800, reason: 'Check deployment' }),
    });

    expect(response.status).toBe(500);
    expect(clearTaskWaitSchedule).toHaveBeenCalledWith({
      runId: 42,
      waitUntil,
    });
  });
});
