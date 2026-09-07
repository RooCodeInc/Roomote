import { z } from 'zod';

export const taskArtifactTypes = ['general', 'plan', 'visual-proof'] as const;

export const uploadArtifactTypes = ['general'] as const;

export type TaskArtifactType = (typeof taskArtifactTypes)[number];
export type UploadArtifactType = (typeof uploadArtifactTypes)[number];
export type ReservedTaskArtifactType = Exclude<
  TaskArtifactType,
  UploadArtifactType
>;

export const DEFAULT_TASK_ARTIFACT_TYPE: TaskArtifactType = 'general';
export const INVALID_TASK_ARTIFACT_TYPE_ERROR =
  'Missing or invalid artifactType';

export const taskArtifactTypeSchema = z.enum(taskArtifactTypes);
export const uploadArtifactTypeSchema = z.enum(uploadArtifactTypes);

export type ArtifactStorageOwner =
  | { taskId: string; sessionId?: never }
  | { taskId?: never; sessionId: string };

export function getArtifactStorageKey(
  owner: ArtifactStorageOwner,
  artifactId: string,
  path: string,
  version: number,
): string {
  const ownerPrefix = owner.taskId
    ? `tasks/${owner.taskId}`
    : `sessions/${owner.sessionId}`;
  return version === 0
    ? `${ownerPrefix}/artifacts/${artifactId}/${path}`
    : `${ownerPrefix}/artifacts/${artifactId}/v${version}/${path}`;
}

export function validateTaskArtifactPath(path: string): string | null {
  if (!path.trim()) return 'Path cannot be empty';
  if (path.length > 255) return 'Path too long (max 255 chars)';
  if (/(?:^|[/\\])\.\.(?:$|[/\\])/u.test(path)) {
    return 'Invalid path: path traversal detected';
  }
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path)) {
    return 'Invalid path: absolute paths are not allowed';
  }
  if (path.includes('\0')) return 'Invalid path: null byte detected';
  return null;
}

export function resolveCreateArtifactType(params: {
  rawArtifactType: unknown;
  forcedArtifactType?: ReservedTaskArtifactType;
}):
  | { success: true; artifactType: TaskArtifactType }
  | { success: false; error: typeof INVALID_TASK_ARTIFACT_TYPE_ERROR } {
  const requestArtifactType =
    typeof params.rawArtifactType === 'string'
      ? params.rawArtifactType
      : DEFAULT_TASK_ARTIFACT_TYPE;

  if (params.forcedArtifactType) {
    if (
      requestArtifactType !== DEFAULT_TASK_ARTIFACT_TYPE &&
      requestArtifactType !== params.forcedArtifactType
    ) {
      return {
        success: false,
        error: INVALID_TASK_ARTIFACT_TYPE_ERROR,
      };
    }

    return {
      success: true,
      artifactType: params.forcedArtifactType,
    };
  }

  const artifactTypeResult =
    uploadArtifactTypeSchema.safeParse(requestArtifactType);
  if (!artifactTypeResult.success) {
    return {
      success: false,
      error: INVALID_TASK_ARTIFACT_TYPE_ERROR,
    };
  }

  return {
    success: true,
    artifactType: artifactTypeResult.data,
  };
}
