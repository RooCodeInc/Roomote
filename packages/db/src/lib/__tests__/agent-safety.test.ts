import {
  admitTaskInferenceRequest,
  releaseAgentSafetyStopForResume,
  stopTaskForAgentSafety,
  db,
  eq,
  taskFactory,
  runFactory,
  tasks,
  taskMessages,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
} from '../../server';

const taskIds: string[] = [];
const conversationIds: string[] = [];
afterEach(async () => {
  for (const id of taskIds.splice(0))
    await db.delete(tasks).where(eq(tasks.id, id));
  for (const id of conversationIds.splice(0))
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, id));
});
async function seed(limit = 5) {
  const task = await taskFactory.create({ inferenceRequestLimit: limit });
  taskIds.push(task.id);
  const run = await runFactory.create({ taskId: task.id });
  return { task, run };
}

it('serializes concurrent admissions across children and resumed runs, with no cost data', async () => {
  const { task, run } = await seed();
  const resumed = await runFactory.create({ taskId: task.id, kind: 'resume' });
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      admitTaskInferenceRequest(task.id, i % 2 ? run.id : resumed.id),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(5);
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
  expect(row).toMatchObject({
    inferenceRequests: 5,
    safetyStopReason: 'task_request_limit',
  });
  expect(row?.safetyStoppedAt).toBeInstanceOf(Date);
  expect(await admitTaskInferenceRequest(task.id, resumed.id)).toBe(false);
  const notices = await db.query.taskMessages.findMany({
    where: eq(taskMessages.taskId, task.id),
  });
  expect(notices).toHaveLength(1);
});

it('persists exactly one parent notice and stop latch together, independent of inference and later runs', async () => {
  const owner = await userFactory.create();
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: owner.id,
      surface: 'web',
      workspaceId: owner.id,
      conversationId: crypto.randomUUID(),
    })
    .returning();
  conversationIds.push(conversation!.id);
  const { task, run } = await seed();
  // The parent binding is trusted run payload, never supplied by a tool argument.
  const { taskRuns } = await import('../../server');
  await db
    .update(taskRuns)
    .set({
      payload: {
        ...run.payload,
        fastAgentParent: {
          sessionId: conversation!.id,
          conversation: {
            surface: 'web',
            workspaceId: owner.id,
            conversationId: conversation!.conversationId,
          },
        },
      },
    })
    .where(eq(taskRuns.id, run.id));
  await Promise.all(
    Array.from({ length: 10 }, () =>
      stopTaskForAgentSafety({
        taskId: task.id,
        runId: run.id,
        reason: 'identical_tool_loop',
      }),
    ),
  );
  expect(
    await db.query.taskMessages.findMany({
      where: eq(taskMessages.taskId, task.id),
    }),
  ).toHaveLength(1);
  expect(
    await db.query.fastAgentMessages.findMany({
      where: eq(fastAgentMessages.conversationId, conversation!.id),
    }),
  ).toHaveLength(1);
  const restarted = await runFactory.create({ taskId: task.id });
  expect(await admitTaskInferenceRequest(task.id, restarted.id)).toBe(false);
});

it('releases a pass-level stop for a resume without resetting the request counter', async () => {
  const { task, run } = await seed();
  expect(await admitTaskInferenceRequest(task.id, run.id)).toBe(true);
  await stopTaskForAgentSafety({
    taskId: task.id,
    runId: run.id,
    reason: 'identical_tool_loop',
  });
  const resumed = await runFactory.create({ taskId: task.id, kind: 'resume' });
  expect(
    await db.transaction((tx) => releaseAgentSafetyStopForResume(tx, task.id)),
  ).toBe(true);
  expect(await admitTaskInferenceRequest(task.id, resumed.id)).toBe(true);
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
  expect(row).toMatchObject({
    inferenceRequests: 2,
    safetyStoppedAt: null,
    safetyStopReason: null,
  });
  await stopTaskForAgentSafety({
    taskId: task.id,
    runId: resumed.id,
    reason: 'identical_tool_loop',
  });
  expect(
    await db.query.taskMessages.findMany({
      where: eq(taskMessages.taskId, task.id),
    }),
  ).toHaveLength(2);
});

it('keeps a request-ceiling stop latched across resumes', async () => {
  const { task, run } = await seed(1);
  expect(await admitTaskInferenceRequest(task.id, run.id)).toBe(true);
  expect(await admitTaskInferenceRequest(task.id, run.id)).toBe(false);
  expect(
    await db.transaction((tx) => releaseAgentSafetyStopForResume(tx, task.id)),
  ).toBe(false);
  const resumed = await runFactory.create({ taskId: task.id, kind: 'resume' });
  expect(await admitTaskInferenceRequest(task.id, resumed.id)).toBe(false);
});
