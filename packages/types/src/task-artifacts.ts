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
