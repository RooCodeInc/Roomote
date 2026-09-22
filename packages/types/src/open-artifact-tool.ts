import { z } from 'zod';

export const openArtifactInputSchema = z
  .object({
    taskId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Owning task ID. For a task run, omit to use the current task; do not provide both taskId and sessionId.',
      ),
    sessionId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Owning Session ID for a Session artifact. Do not provide both sessionId and taskId.',
      ),
    path: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe(
        'Exact stored artifact path, including its category prefix when present (for example plans/summary.md).',
      ),
    version: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Artifact version to open. Omit to open the latest uploaded version.',
      ),
  })
  .strict();

export type OpenArtifactInput = z.infer<typeof openArtifactInputSchema>;

export const OPEN_ARTIFACT_TOOL = {
  name: 'open_artifact',
  title: 'Open Artifact',
  description:
    'Open an artifact that the current actor is authorized to access. Provide the exact owning taskId or sessionId and stored path; never guess an artifact ID or path. Omit taskId only when the current task run is the owner. Results include artifact metadata and bounded content for supported text artifacts. Binary or otherwise unsupported formats return an explicit unsupported-format error with metadata but no content; missing, unauthorized, incomplete, and oversized artifacts return an error. Future artifact formats may add other representations without changing this tool name or ownership contract.',
  inputSchema: openArtifactInputSchema.shape,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;
