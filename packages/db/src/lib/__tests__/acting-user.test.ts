import {
  compareAndSetTrustedRunActingUser,
  db,
  eq,
  runFactory,
  setTrustedRunActingUser,
  setTrustedRunActingUserOnSuccess,
  taskRuns,
  tasks,
  userFactory,
} from '../../server';

const createdTaskIds: string[] = [];

async function createRunWithActors() {
  const [firstUser, secondUser, thirdUser] = await Promise.all([
    userFactory.create(),
    userFactory.create(),
    userFactory.create(),
  ]);
  const run = await runFactory.create({ actingUserId: firstUser.id });
  createdTaskIds.push(run.taskId);

  return { run, firstUser, secondUser, thirdUser };
}

async function readActingUserId(runId: number) {
  const [row] = await db
    .select({ actingUserId: taskRuns.actingUserId })
    .from(taskRuns)
    .where(eq(taskRuns.id, runId));

  return row?.actingUserId;
}

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    await db
      .delete(tasks)
      .where(eq(tasks.id, createdTaskIds.pop()!))
      .catch(() => {});
  }
});

describe('trusted run acting-user writes', () => {
  it('sets a webhook-resolved sender as the live actor', async () => {
    const { run, secondUser } = await createRunWithActors();

    await setTrustedRunActingUser({
      runId: run.id,
      userId: secondUser.id,
    });

    expect(await readActingUserId(run.id)).toBe(secondUser.id);
  });

  it('compare-and-set refuses to overwrite a newer actor', async () => {
    const { run, firstUser, secondUser, thirdUser } =
      await createRunWithActors();

    expect(
      await compareAndSetTrustedRunActingUser({
        runId: run.id,
        expectedUserId: firstUser.id,
        nextUserId: secondUser.id,
      }),
    ).toBe(true);

    expect(
      await compareAndSetTrustedRunActingUser({
        runId: run.id,
        expectedUserId: firstUser.id,
        nextUserId: thirdUser.id,
      }),
    ).toBe(false);
    expect(await readActingUserId(run.id)).toBe(secondUser.id);
  });

  it('changes the actor only when the trusted external claim succeeds', async () => {
    const { run, firstUser, secondUser } = await createRunWithActors();

    expect(
      await setTrustedRunActingUserOnSuccess({
        runId: run.id,
        userId: secondUser.id,
        operation: async () => false,
      }),
    ).toBe(false);
    expect(await readActingUserId(run.id)).toBe(firstUser.id);

    expect(
      await setTrustedRunActingUserOnSuccess({
        runId: run.id,
        userId: secondUser.id,
        operation: async () => true,
      }),
    ).toBe(true);
    expect(await readActingUserId(run.id)).toBe(secondUser.id);
  });
});
