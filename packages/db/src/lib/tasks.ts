import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { BackgroundAutomationKey } from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { tasks } from '../schema';
import type { CreateTask, Task } from '../types';

import { generateTaskId } from './task-id';

/**
 * Predicate for task rows a user is allowed to read. A task is visible only
 * when it is marked `visibility = 'visible'` AND has not been soft-deleted
 * (`deletedAt IS NULL`). Soft-deleted rows are retained for satellites and
 * artifact cleanup, so this predicate must exclude them from API reads.
 */
export function isVisibleTask(): SQL {
  return and(eq(tasks.visibility, 'visible'), isNull(tasks.deletedAt)) as SQL;
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

export async function touchTaskActivity(
  database: DatabaseOrTransaction,
  taskId: string,
  at = Math.floor(Date.now() / 1_000),
): Promise<void> {
  await database
    .update(tasks)
    .set({ activityAt: sql`GREATEST(${tasks.activityAt}, ${at})` })
    .where(eq(tasks.id, taskId));
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

/**
 * Resolves the automation that launched a task, or null for user-initiated
 * tasks. The initiator columns are the single source of truth here: only some
 * automations stamp an automation key into the run payload, so payload reads
 * silently miss most automation launches.
 */
export async function getTaskAutomationInitiatorKey(
  taskId: string,
  database: DatabaseOrTransaction = db,
): Promise<BackgroundAutomationKey | null> {
  const [task] = await database
    .select({
      initiatorKind: tasks.initiatorKind,
      initiatorAutomation: tasks.initiatorAutomation,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  return task?.initiatorKind === 'automation'
    ? (task.initiatorAutomation ?? null)
    : null;
}
