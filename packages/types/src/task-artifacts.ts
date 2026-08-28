import { z } from 'zod';

export const taskArtifactTypes = [
  'general',
  'plan',
  'visual-proof',
  'architecture-snapshot',
] as const;

export const uploadArtifactTypes = [
  'general',
  'architecture-snapshot',
] as const;

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

export const ARCHITECTURE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const urlSchemePattern = /^[a-z][a-z\d+.-]*:/i;

export const architectureSnapshotSourceSchema = z
  .object({
    repository: z
      .string()
      .min(1)
      .max(300)
      .refine((value) => value === value.trim(), 'Repository must be trimmed')
      .refine(
        (value) => !controlCharacterPattern.test(value),
        'Repository must not contain control characters',
      ),
    path: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value === value.trim(), 'Path must be trimmed')
      .refine(
        (value) => !controlCharacterPattern.test(value),
        'Path must not contain control characters',
      )
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.startsWith('\\') &&
          !value.includes('\\') &&
          !urlSchemePattern.test(value) &&
          value
            .split('/')
            .every(
              (segment) =>
                segment.length > 0 && segment !== '.' && segment !== '..',
            ),
        'Path must be a repository-relative file path',
      ),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    description: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.lineEnd !== undefined && source.lineStart === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lineEnd'],
        message: 'lineEnd requires lineStart',
      });
    }

    if (
      source.lineStart !== undefined &&
      source.lineEnd !== undefined &&
      source.lineEnd < source.lineStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lineEnd'],
        message: 'lineEnd must be greater than or equal to lineStart',
      });
    }
  });

export const architectureSnapshotSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_SNAPSHOT_SCHEMA_VERSION),
    title: z.string().min(1).max(200),
    mermaid: z
      .string()
      .min(1)
      .max(100_000)
      .refine(
        (value) => !value.includes('\u0000'),
        'Mermaid source must not contain null bytes',
      ),
    sources: z.array(architectureSnapshotSourceSchema).min(1).max(100),
  })
  .strict();

export type ArchitectureSnapshot = z.infer<typeof architectureSnapshotSchema>;

export function parseArchitectureSnapshot(content: string) {
  try {
    return architectureSnapshotSchema.safeParse(JSON.parse(content));
  } catch {
    return architectureSnapshotSchema.safeParse(undefined);
  }
}

export function serializeArchitectureSnapshot(
  snapshot: ArchitectureSnapshot,
): string {
  const validatedSnapshot = architectureSnapshotSchema.parse(snapshot);
  return `${JSON.stringify(validatedSnapshot, null, 2)}\n`;
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
