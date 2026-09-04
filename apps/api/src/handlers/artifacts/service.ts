import {
  db,
  taskArtifacts,
  tasks,
  eq,
  and,
  asc,
  desc,
} from '@roomote/db/server';
import {
  type TaskArtifactType,
  validateTaskArtifactPath,
} from '@roomote/types';

type ArtifactAuthContext = Record<string, never>;

export async function getArtifactById(input: {
  taskId: string;
  artifactId: string;
  auth: ArtifactAuthContext;
}) {
  const result = await db
    .select()
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(
      and(
        eq(taskArtifacts.id, input.artifactId),
        eq(taskArtifacts.taskId, input.taskId),
      ),
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const row = result[0]!;
  return {
    ...row.task_artifacts,
    task: row.tasks,
  };
}

export async function getArtifactByPath(input: {
  taskId: string;
  path: string;
  version?: number;
  auth: ArtifactAuthContext;
}) {
  const whereConditions = [
    eq(taskArtifacts.taskId, input.taskId),
    eq(taskArtifacts.path, input.path),
  ];

  if (input.version !== undefined) {
    whereConditions.push(eq(taskArtifacts.version, input.version));
  }

  const result = await db
    .select()
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(and(...whereConditions))
    .orderBy(desc(taskArtifacts.version))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const row = result[0]!;
  return {
    ...row.task_artifacts,
    task: row.tasks,
  };
}

/**
 * List a task's uploaded artifacts, keeping only the latest version per
 * artifact path. Optionally filtered by artifact type.
 */
export async function listArtifactsByTask(input: {
  taskId: string;
  artifactType?: TaskArtifactType;
  auth: ArtifactAuthContext;
}) {
  const whereConditions = [
    eq(taskArtifacts.taskId, input.taskId),
    eq(taskArtifacts.uploaded, true),
  ];

  if (input.artifactType !== undefined) {
    whereConditions.push(eq(taskArtifacts.artifactType, input.artifactType));
  }

  const rows = await db
    .select()
    .from(taskArtifacts)
    .where(and(...whereConditions))
    .orderBy(asc(taskArtifacts.createdAt), desc(taskArtifacts.version));

  const latestByPath = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = latestByPath.get(row.path);
    if (!existing || row.version > existing.version) {
      latestByPath.set(row.path, row);
    }
  }

  return [...latestByPath.values()];
}

export async function verifyTaskAccessForArtifact(
  taskId: string,
  _auth: ArtifactAuthContext,
): Promise<boolean> {
  const result = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  return result.length > 0;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024;

export function validateArtifactPath(path: string): {
  valid: boolean;
  error?: string;
} {
  const error = validateTaskArtifactPath(path);
  return error ? { valid: false, error } : { valid: true };
}

export function validateArtifactSize(size: number): {
  valid: boolean;
  error?: string;
} {
  if (size <= 0) {
    return { valid: false, error: 'File size must be positive' };
  }

  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
    };
  }

  return { valid: true };
}
