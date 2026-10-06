import { z } from 'zod';

import {
  taskArtifactTypeSchema,
  validateTaskArtifactPath,
} from './task-artifacts';

export const TASK_OUTPUT_READ_ACTIONS = [
  'list_artifacts',
  'get_artifact_download_url',
  'get_command_receipts',
] as const;

export const taskOutputFieldSchemas = {
  path: z
    .string()
    .min(1)
    .max(255)
    .refine((path) => !validateTaskArtifactPath(path))
    .optional()
    .describe(
      'Exact uploaded artifact path, including its category prefix; required for get_artifact_download_url.',
    ),
  version: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Artifact version for get_artifact_download_url; omit for the latest uploaded version.',
    ),
  artifactType: taskArtifactTypeSchema
    .optional()
    .describe('Optional uploaded artifact type filter for list_artifacts.'),
};

const taskId = z.string().regex(/^[0-9a-z]{13}$/);
export const taskOutputReadInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list_artifacts'),
      taskId,
      artifactType: taskOutputFieldSchemas.artifactType,
    })
    .strict(),
  z
    .object({
      action: z.literal('get_artifact_download_url'),
      taskId,
      path: taskOutputFieldSchemas.path.unwrap(),
      version: taskOutputFieldSchemas.version,
    })
    .strict(),
  z
    .object({
      action: z.literal('get_command_receipts'),
      taskId,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().max(2048).optional(),
    })
    .strict(),
]);
