import { z } from 'zod/v4';

const id = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

const project = z.union([
  id,
  z.number().int().positive(),
  z.string().regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
]);

const text = z.string().min(1);
const path = text.refine(
  (value) =>
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..'),
);
const pagination = {
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
};
export const gitLabPageTokenSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
const mr = { project_id: project, merge_request_iid: id };

export const gitLabToolSchemas = {
  get_file_contents: z.strictObject({
    project_id: project,
    file_path: path,
    ref: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .describe(
        'Full immutable commit SHA. Resolve a branch with get_commit first.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based line offset; default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'Maximum lines; default 2000. Files over 1 MiB are rejected even for a small window.',
      ),
  }),
  get_repository_tree: z.strictObject({
    project_id: project,
    path: path.optional(),
    ref: text.optional(),
    recursive: z.boolean().optional(),
    per_page: pagination.per_page,
    page_token: gitLabPageTokenSchema.optional(),
    pagination: z
      .literal('keyset')
      .optional()
      .describe(
        'Keyset pagination; pass next_page_token as page_token to continue.',
      ),
  }),
  search_project_code: z.strictObject({
    project_id: project,
    search: text,
    ref: text.optional(),
    ...pagination,
  }),
  list_commits: z.strictObject({
    project_id: project,
    ref_name: text.optional(),
    path: path.optional(),
    ...pagination,
  }),
  get_commit: z.strictObject({ project_id: project, sha: path }),
  get_merge_request: z.strictObject(mr),
  list_merge_request_diffs: z.strictObject({ ...mr, ...pagination }),
  get_merge_request_notes: z.strictObject({ ...mr, ...pagination }),
  mr_discussions: z.strictObject({ ...mr, ...pagination }),
  update_merge_request: z
    .strictObject({
      ...mr,
      title: text.optional(),
      description: z.string().optional(),
      state_event: z.enum(['close', 'reopen']).optional(),
    })
    .refine(
      (input) =>
        input.title !== undefined ||
        input.description !== undefined ||
        input.state_event !== undefined,
      { message: 'At least one merge request update is required.' },
    ),
  create_merge_request_note: z.strictObject({ ...mr, body: text }),
  create_merge_request_discussion_note: z.strictObject({
    ...mr,
    discussion_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    body: text,
  }),
};

export type GitLabToolName = keyof typeof gitLabToolSchemas;
export type GitLabToolInput = z.infer<
  (typeof gitLabToolSchemas)[GitLabToolName]
>;

export const gitLabWriteTools = new Set<GitLabToolName>([
  'update_merge_request',
  'create_merge_request_note',
  'create_merge_request_discussion_note',
]);
