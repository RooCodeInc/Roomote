import { and, eq, inArray, notExists, type SQL } from 'drizzle-orm';

import { HIDDEN_CLOUD_TASK_TYPES } from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import { cloudJobs, tasks } from '../schema';
import type { CreateTask, Task } from '../types';

import { generateTaskId } from './task-id';

export function isVisibleTask(taskIdColumn: typeof tasks.id): SQL {
  return notExists(
    db
      .select({ hiddenCloudJobId: cloudJobs.id })
      .from(cloudJobs)
      .where(
        and(
          eq(cloudJobs.taskId, taskIdColumn),
          inArray(cloudJobs.type, [...HIDDEN_CLOUD_TASK_TYPES]),
        ),
      ),
  );
}

const UNIQUE_VIOLATION_CODE = '23505';

const TASK_PRIMARY_KEY_CONSTRAINT = 'tasks_pkey';

const DEFAULT_MAX_ATTEMPTS = 5;

type PostgresErrorLike = {
  code?: string;
  constraint?: string;
  table?: string;
  message?: string;
};

type CreateTaskWithRetryOptions = {
  db?: DatabaseOrTransaction;
  maxAttempts?: number;
  /**
   * Optional override to make retry behavior deterministic in tests.
   */
  idGenerator?: () => string;
};

type CreateTaskInsert = Omit<CreateTask, 'activityAt'> & {
  activityAt?: CreateTask['activityAt'];
};

export async function createTaskWithRetry(
  values: CreateTaskInsert,
  options: CreateTaskWithRetryOptions = {},
): Promise<Task> {
  const database = options.db ?? db;

  // Caller supplied the ID (e.g. snapshot resume path); do not replace it.
  if (values.id) {
    return insertTask(database, values);
  }

  const maxAttempts = Math.max(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1);
  const idGenerator = options.idGenerator ?? generateTaskId;
  let lastCollisionError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await insertTask(database, { ...values, id: idGenerator() });
    } catch (error) {
      if (!isTaskIdCollisionError(error)) {
        throw error;
      }

      lastCollisionError = error;
    }
  }

  throw new Error(
    `Failed to create task after ${maxAttempts} ID generation attempts.`,
    { cause: lastCollisionError },
  );
}

async function insertTask(
  database: DatabaseOrTransaction,
  values: CreateTaskInsert,
): Promise<Task> {
  const [createdTask] = await database
    .insert(tasks)
    .values({
      ...values,
      activityAt: values.activityAt ?? values.timestamp,
    })
    .returning();

  if (!createdTask) {
    throw new Error('Failed to create `tasks` record.');
  }

  return createdTask;
}

function isTaskIdCollisionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const e = error as PostgresErrorLike;
  if (e.code !== UNIQUE_VIOLATION_CODE) {
    return false;
  }

  if (e.constraint === TASK_PRIMARY_KEY_CONSTRAINT) {
    return true;
  }

  if (e.table === 'tasks' && !e.constraint) {
    return true;
  }

  return (
    typeof e.message === 'string' &&
    e.message.includes(TASK_PRIMARY_KEY_CONSTRAINT)
  );
}
