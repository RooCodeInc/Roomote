import { db, taskArtifacts, tasks, eq, and, desc } from '@roomote/db/server';
import type { TaskArtifactType } from '@roomote/types';

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
 * This is the common subset of JobAuthTokenSuccess, UserAuthTokenSuccess, and UserAuthSuccess.
 * All these types include userId and isAdmin.
 */
type ArtifactAuth = {
  userId: string;
  isAdmin: boolean;
};

/**
 * Get an artifact by its ID.
 */
export async function getArtifactById({
  taskId,
  artifactId,
  auth: _auth,
}: {
  taskId: string;
  artifactId: string;
  auth: ArtifactAuth;
}) {
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
 * If version is not specified, returns the latest version.
 */
export async function getArtifactByPath({
  taskId,
  path,
  version,
  auth: _auth,
}: {
  taskId: string;
  path: string;
  version?: number;
  auth: ArtifactAuth;
}) {
  const whereConditions = [
    eq(taskArtifacts.taskId, taskId),
    eq(taskArtifacts.path, path),
  ];

  // If version is specified, filter by that version
  if (version !== undefined) {
    whereConditions.push(eq(taskArtifacts.version, version));
  }

  const result = await db
    .select()
    .from(taskArtifacts)
    .innerJoin(tasks, eq(taskArtifacts.taskId, tasks.id))
    .where(and(...whereConditions))
    .orderBy(desc(taskArtifacts.version))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0]!;
  return {
    ...withTypedArtifactType(row.task_artifacts),
    task: row.tasks,
  };
}

/**
 * Get all versions of an artifact by task ID and path.
 * Returns an array of version info sorted by version descending (latest first).
 */
export async function getArtifactVersionsByPath({
  taskId,
  path,
  auth: _auth,
}: {
  taskId: string;
  path: string;
  auth: ArtifactAuth;
}) {
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
  auth: _auth,
  uploadedOnly = true,
}: {
  taskId: string;
  auth: ArtifactAuth;
  uploadedOnly?: boolean;
}) {
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

const MAX_PATH_LENGTH = 255;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export function validateArtifactPath(path: string): {
  valid: boolean;
  error?: string;
} {
  if (!path || path.trim() === '') {
    return { valid: false, error: 'Path cannot be empty' };
  }

  if (path.length > MAX_PATH_LENGTH) {
    return {
      valid: false,
      error: `Path too long (max ${MAX_PATH_LENGTH} chars)`,
    };
  }

  // Check for path traversal attempts
  // Match ".." only when it's a path segment (preceded/followed by / or \ or at boundaries)
  // This allows valid filenames like "file..name.txt" while blocking "../", "..\", etc.
  const pathTraversalPattern = /(?:^|[/\\])\.\.(?:$|[/\\])/;

  if (pathTraversalPattern.test(path)) {
    return { valid: false, error: 'Invalid path: path traversal detected' };
  }

  // Check for absolute paths (should be relative)
  if (path.startsWith('/')) {
    return {
      valid: false,
      error: 'Invalid path: must be relative to workspace',
    };
  }

  // Check for null bytes (security)
  if (path.includes('\0')) {
    return { valid: false, error: 'Invalid path: contains null byte' };
  }

  return { valid: true };
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
