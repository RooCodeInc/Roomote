import { z } from 'zod';

export const ROOMOTE_TASK_INSPECTION_ACTIONS = [
  'search',
  'get_summary',
  'get_compute_logs',
  'get_messages',
] as const;

export const roomoteTaskInspectionFieldSchemas = {
  taskId: z
    .string()
    .optional()
    .describe(
      'The task ID; get_messages and send_message also accept a canonical Fast session ID when those actions are available',
    ),
  query: z
    .string()
    .optional()
    .describe('Text to search for in task prompts (for search action)'),
  status: z
    .enum(['active', 'completed', 'all'])
    .optional()
    .describe('Filter by task status (for search action)'),
  pullRequest: z
    .string()
    .optional()
    .describe(
      'Filter by pull request for search action: "__has_pr__" for any linked PR or "owner/repo#123" for a specific PR',
    ),
  limit: z
    .number()
    .int()
    .refine((value) => value >= 1 && value <= 1000, {
      message: 'Limit must be between 1 and 1,000.',
    })
    .optional()
    .describe(
      'Positive result limit: 1 to 100 for search (default 20), or 1 to 1000 for get_messages (task or Fast session)',
    ),
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from a previous search response (nextCursor)'),
} satisfies Record<string, z.ZodTypeAny>;

export const roomoteTaskInspectionArgsSchema = z
  .object({
    action: z.enum(ROOMOTE_TASK_INSPECTION_ACTIONS),
    ...roomoteTaskInspectionFieldSchemas,
  })
  .strict();

export type RoomoteTaskInspectionArgs = z.infer<
  typeof roomoteTaskInspectionArgsSchema
>;
