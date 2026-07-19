import { z } from 'zod';

const gitLabUserSchema = z
  .object({
    id: z.number().optional(),
    username: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const gitLabProjectSchema = z
  .object({
    id: z.number(),
    path_with_namespace: z.string().optional(),
    web_url: z.string().optional(),
    git_http_url: z.string().optional(),
  })
  .passthrough();

const gitLabMergeRequestAttributesSchema = z
  .object({
    action: z.string(),
    id: z.number().optional(),
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    url: z.string(),
    state: z.string().optional(),
    draft: z.boolean().optional(),
    // GitLab webhook timestamps use `YYYY-MM-DD HH:MM:SS UTC`.
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    oldrev: z.string().optional(),
    last_commit: z
      .object({
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const gitLabMergeRequestWebhookSchema = z
  .object({
    object_kind: z.literal('merge_request'),
    event_type: z.string().optional(),
    user: gitLabUserSchema.optional(),
    project: gitLabProjectSchema,
    object_attributes: gitLabMergeRequestAttributesSchema,
    changes: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type GitLabMergeRequestWebhook = z.infer<
  typeof gitLabMergeRequestWebhookSchema
>;

const gitLabNoteAttributesSchema = z
  .object({
    id: z.number().optional(),
    note: z.string(),
    noteable_type: z.string(),
    action: z.string().optional(),
    system: z.boolean().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const gitLabNoteMergeRequestSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    last_commit: z
      .object({
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const gitLabNoteIssueSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export const gitLabNoteWebhookSchema = z
  .object({
    object_kind: z.literal('note'),
    event_type: z.string().optional(),
    user: gitLabUserSchema.optional(),
    project: gitLabProjectSchema,
    object_attributes: gitLabNoteAttributesSchema,
    merge_request: gitLabNoteMergeRequestSchema.optional(),
    issue: gitLabNoteIssueSchema.optional(),
  })
  .passthrough();

export type GitLabNoteWebhook = z.infer<typeof gitLabNoteWebhookSchema>;
