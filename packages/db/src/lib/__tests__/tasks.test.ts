import { and, db, eq, tasks, taskFactory } from '../../server';

import { createTaskWithRetry, isVisibleTask } from '../tasks';

function makePkCollisionError() {
  const error = new Error(
    'duplicate key value violates unique constraint "tasks_pkey"',
  );

  Object.assign(error, {
    code: '23505',
    constraint: 'tasks_pkey',
    table: 'tasks',
  });

  return error;
}

function makeOtherUniqueError() {
  const error = new Error(
    'duplicate key value violates unique constraint "tasks_slug_unique"',
  );

  Object.assign(error, {
    code: '23505',
    constraint: 'tasks_slug_unique',
    table: 'tasks',
  });

  return error;
}

function makeNonPgError() {
  return new Error('connection refused');
}

const fakeTask = (id: string) => ({
  id,
  title: 'Test Task',
  timestamp: 1_700_000_000,
  activityAt: 1_700_000_000,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function mockDb(impl: (...args: unknown[]) => unknown) {
  return {
    insert: () => ({
      values: () => ({
        returning: impl,
      }),
    }),
  } as never;
}

const baseValues = {
  title: 'Test Task',
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  timestamp: 1_700_000_000,
  workflow: 'standard',
  surface: 'web',
  trigger: 'manual',
  initiatorKind: 'user',
  actorExternalId: 'ext-user-1',
} satisfies Parameters<typeof createTaskWithRetry>[0];

describe('createTaskWithRetry', () => {
  it('defaults activityAt to timestamp when it is omitted', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const task = fakeTask('generated-id');
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            returning: () => Promise.resolve([task]),
          };
        },
      }),
    } as never;

    await createTaskWithRetry(baseValues, {
      db,
      idGenerator: () => 'generated-id',
    });

    expect(insertedValues).toMatchObject({
      id: 'generated-id',
      timestamp: baseValues.timestamp,
      activityAt: baseValues.timestamp,
    });
  });

  it('inserts with a generated ID when no id is provided', async () => {
    const task = fakeTask('generated-id');
    const db = mockDb(() => Promise.resolve([task]));

    const result = await createTaskWithRetry(baseValues, {
      db,
      idGenerator: () => 'generated-id',
    });

    expect(result).toEqual(task);
  });

  it('uses the caller-supplied id without generating one', async () => {
    const task = fakeTask('my-custom-id');
    const db = mockDb(() => Promise.resolve([task]));
    const idGenerator = vi.fn();

    const result = await createTaskWithRetry(
      { ...baseValues, id: 'my-custom-id' },
      { db, idGenerator },
    );

    expect(result).toEqual(task);
    expect(idGenerator).not.toHaveBeenCalled();
  });

  it('retries on primary key collision and succeeds', async () => {
    let attempt = 0;
    const db = mockDb(() => {
      attempt++;
      if (attempt === 1) throw makePkCollisionError();
      return Promise.resolve([fakeTask('second-id')]);
    });

    const ids = ['colliding-id', 'second-id'];
    let idx = 0;

    const result = await createTaskWithRetry(baseValues, {
      db,
      idGenerator: () => ids[idx++]!,
    });

    expect(result.id).toBe('second-id');
    expect(idx).toBe(2);
  });

  it('throws after exhausting all retry attempts', async () => {
    const db = mockDb(() => {
      throw makePkCollisionError();
    });

    await expect(
      createTaskWithRetry(baseValues, {
        db,
        maxAttempts: 3,
        idGenerator: () => 'always-collides',
      }),
    ).rejects.toThrow('Failed to create task after 3 ID generation attempts.');
  });

  it('does not retry on non-PK unique constraint violations', async () => {
    const db = mockDb(() => {
      throw makeOtherUniqueError();
    });

    const idGenerator = vi.fn(() => 'some-id');

    await expect(
      createTaskWithRetry(baseValues, { db, idGenerator }),
    ).rejects.toThrow('tasks_slug_unique');

    expect(idGenerator).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-Postgres errors', async () => {
    const db = mockDb(() => {
      throw makeNonPgError();
    });

    const idGenerator = vi.fn(() => 'some-id');

    await expect(
      createTaskWithRetry(baseValues, { db, idGenerator }),
    ).rejects.toThrow('connection refused');

    expect(idGenerator).toHaveBeenCalledTimes(1);
  });

  it('treats maxAttempts < 1 as 1', async () => {
    const db = mockDb(() => {
      throw makePkCollisionError();
    });

    await expect(
      createTaskWithRetry(baseValues, {
        db,
        maxAttempts: 0,
        idGenerator: () => 'id',
      }),
    ).rejects.toThrow('Failed to create task after 1 ID generation attempts.');
  });

  it('retries on collision errors that match by message only', async () => {
    let attempt = 0;
    const db = mockDb(() => {
      attempt++;
      if (attempt === 1) {
        const error = new Error(
          'duplicate key value violates unique constraint "tasks_pkey"',
        );
        Object.assign(error, { code: '23505' });
        throw error;
      }
      return Promise.resolve([fakeTask('ok-id')]);
    });

    const result = await createTaskWithRetry(baseValues, {
      db,
      idGenerator: () => `id-${attempt}`,
    });

    expect(result.id).toBe('ok-id');
  });
});

describe('isVisibleTask', () => {
  const createdTaskIds: string[] = [];

  afterEach(async () => {
    while (createdTaskIds.length > 0) {
      const taskId = createdTaskIds.pop()!;
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });

  it('excludes soft-deleted tasks from visible reads', async () => {
    const visibleTask = await taskFactory.create({ visibility: 'visible' });
    const deletedTask = await taskFactory.create({
      visibility: 'visible',
      deletedAt: new Date(),
    });
    createdTaskIds.push(visibleTask.id, deletedTask.id);

    const [foundVisible] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, visibleTask.id), isVisibleTask()));
    const [foundDeleted] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, deletedTask.id), isVisibleTask()));

    expect(foundVisible?.id).toBe(visibleTask.id);
    expect(foundDeleted).toBeUndefined();
  });
});
