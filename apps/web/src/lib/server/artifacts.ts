import {
  db,
  taskArtifacts,
  tasks,
  eq,
  and,
  desc,
  getTaskArtifactByPath,
  getSessionArtifactByPath,
} from '@roomote/db/server';
import {
  type TaskArtifactType,
  validateTaskArtifactPath,
} from '@roomote/types';
import { canReadTask } from './custom-automation-task-access';

function withTypedArtifactType<T extends { artifactType: string }>(
  artifact: T,
): Omit<T, 'artifactType'> & { artifactType: TaskArtifactType } {
  return {
    ...artifact,
    artifactType: artifact.artifactType as TaskArtifactType,
  };
}

/**
 * Auth context for artifact access checks.
 * This is the common subset of RunAuthTokenSuccess, UserAuthTokenSuccess, and UserAuthSuccess.
 * All these types include userId and isAdmin.
 */
type ArtifactAuth = {
  /** Null for deployment-principal run tokens (no human user). */
  userId: string | null;
  isAdmin: boolean;
};

/**
 * Get an artifact by its ID.
 */
export async function getArtifactById({
  taskId,
  artifactId,
  auth,
}: {
  taskId: string;
  artifactId: string;
  auth: ArtifactAuth;
}) {
  if (!auth.userId) return null;
  const result = await db
    .select()
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(
      and(eq(taskArtifacts.id, artifactId), eq(taskArtifacts.taskId, taskId)),
    )
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0]!;
  return {
    ...withTypedArtifactType(row.task_artifacts),
    task: row.tasks,
  };
}

/**
 * Get an artifact by task ID and path.
 * If version is not specified, returns the latest uploaded version.
 */
export async function getArtifactByPath({
  taskId,
  path,
  version,
  auth,
}: {
  taskId: string;
  path: string;
  version?: number;
  auth: ArtifactAuth;
}) {
  if (!(await canReadTask(auth, taskId))) return null;
  const artifact = await getTaskArtifactByPath({ taskId, path, version });
  return artifact ? withTypedArtifactType(artifact) : null;
}

export async function getArtifactBySessionPath({
  sessionId,
  path,
  version,
  auth: _auth,
}: {
  sessionId: string;
  path: string;
  version?: number;
  auth: ArtifactAuth;
}) {
  const artifact = await getSessionArtifactByPath({ sessionId, path, version });
  return artifact ? withTypedArtifactType(artifact) : null;
}

export async function getArtifactVersionsBySessionPath({
  sessionId,
  path,
  auth: _auth,
}: {
  sessionId: string;
  path: string;
  auth: ArtifactAuth;
}) {
  return db
    .select({
      id: taskArtifacts.id,
      version: taskArtifacts.version,
      size: taskArtifacts.size,
      createdAt: taskArtifacts.createdAt,
    })
    .from(taskArtifacts)
    .where(
      and(
        eq(taskArtifacts.sessionId, sessionId),
        eq(taskArtifacts.path, path),
        eq(taskArtifacts.uploaded, true),
      ),
    )
    .orderBy(desc(taskArtifacts.version));
}

/**
 * Get all versions of an artifact by task ID and path.
 * Returns an array of version info sorted by version descending (latest first).
 */
export async function getArtifactVersionsByPath({
  taskId,
  path,
  auth,
}: {
  taskId: string;
  path: string;
  auth: ArtifactAuth;
}) {
  if (!auth.userId) return [];
  const result = await db
    .select({
      id: taskArtifacts.id,
      version: taskArtifacts.version,
      size: taskArtifacts.size,
      createdAt: taskArtifacts.createdAt,
    })
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(
      and(
        eq(taskArtifacts.taskId, taskId),
        eq(taskArtifacts.path, path),
        eq(taskArtifacts.uploaded, true),
      ),
    )
    .orderBy(desc(taskArtifacts.version));

  return result;
}

/**
 * Get all artifacts for a task.
 */
export async function getArtifactsForTask({
  taskId,
  auth,
  uploadedOnly = true,
}: {
  taskId: string;
  auth: ArtifactAuth;
  uploadedOnly?: boolean;
}) {
  if (!auth.userId) return [];
  const artifactConditions = [eq(taskArtifacts.taskId, taskId)];

  if (uploadedOnly) {
    artifactConditions.push(eq(taskArtifacts.uploaded, true));
  }

  const result = await db
    .select({
      id: taskArtifacts.id,
      path: taskArtifacts.path,
      version: taskArtifacts.version,
      artifactType: taskArtifacts.artifactType,
      contentType: taskArtifacts.contentType,
      size: taskArtifacts.size,
      createdAt: taskArtifacts.createdAt,
    })
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(and(...artifactConditions));

  return result.map((artifact) => withTypedArtifactType(artifact));
}

/**
 * Get an artifact by ID without auth checks (for public raw endpoint).
 * Only returns artifacts that have been uploaded.
 */
export async function getUploadedArtifactById(artifactId: string) {
  const result = await db
    .select()
    .from(taskArtifacts)
    .where(
      and(eq(taskArtifacts.id, artifactId), eq(taskArtifacts.uploaded, true)),
    )
    .limit(1);

  if (result.length === 0) return null;
  return result[0]!;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

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
