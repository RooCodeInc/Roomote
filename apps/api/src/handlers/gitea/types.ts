import { z } from 'zod';

const giteaUserSchema = z
  .object({
    id: z.number().optional(),
    login: z.string().optional(),
    username: z.string().optional(),
    full_name: z.string().optional(),
  })
  .passthrough();

const giteaRepositorySchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    full_name: z.string(),
    html_url: z.string().optional(),
  })
  .passthrough();

const giteaPullRequestBranchSchema = z
  .object({
    ref: z.string().optional(),
    sha: z.string().optional(),
  })
  .passthrough();

const giteaPullRequestSchema = z
  .object({
    id: z.number().optional(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    state: z.string().optional(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    head: giteaPullRequestBranchSchema.optional(),
    base: giteaPullRequestBranchSchema.optional(),
    user: giteaUserSchema.optional(),
  })
  .passthrough();

export const giteaPullRequestWebhookSchema = z
  .object({
    action: z.string(),
    number: z.number(),
    pull_request: giteaPullRequestSchema,
    repository: giteaRepositorySchema,
    sender: giteaUserSchema.optional(),
    commit_id: z.string().optional(),
  })
  .passthrough();

export type GiteaPullRequestWebhook = z.infer<
  typeof giteaPullRequestWebhookSchema
>;

const giteaCommentSchema = z
  .object({
    id: z.number().optional(),
    body: z.string(),
    html_url: z.string().optional(),
    user: giteaUserSchema.optional(),
  })
  .passthrough();

const giteaIssueSchema = z
  .object({
    number: z.number(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    user: giteaUserSchema.optional(),
  })
  .passthrough();

export const giteaPullRequestCommentWebhookSchema = z
  .object({
    action: z.string(),
    issue: giteaIssueSchema.optional(),
    pull_request: giteaPullRequestSchema.optional(),
    comment: giteaCommentSchema,
    repository: giteaRepositorySchema,
    sender: giteaUserSchema.optional(),
    is_pull: z.boolean().optional(),
  })
  .passthrough();

export type GiteaPullRequestCommentWebhook = z.infer<
  typeof giteaPullRequestCommentWebhookSchema
>;

const giteaIssueLabelSchema = z.union([
  z.string(),
  z
    .object({
      id: z.number().optional(),
      name: z.string().optional(),
    })
    .passthrough(),
]);

const giteaPlainIssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    state: z.string().optional(),
    user: giteaUserSchema.optional(),
    labels: z.array(giteaIssueLabelSchema).optional(),
    pull_request: z.unknown().optional(),
  })
  .passthrough();

export const giteaIssueWebhookSchema = z
  .object({
    action: z.string(),
    number: z.number().optional(),
    issue: giteaPlainIssueSchema,
    repository: giteaRepositorySchema,
    sender: giteaUserSchema.optional(),
    is_pull: z.boolean().optional(),
    pull_request: giteaPullRequestSchema.optional(),
  })
  .passthrough();

export type GiteaIssueWebhook = z.infer<typeof giteaIssueWebhookSchema>;

const giteaActionWorkflowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const giteaActionWorkflowRunSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    display_title: z.string().optional(),
    path: z.string().optional(),
    event: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    head_branch: z.string().optional(),
    head_sha: z.string().optional(),
    run_number: z.number().optional(),
  })
  .passthrough();

export const giteaWorkflowRunWebhookSchema = z
  .object({
    action: z.string().optional(),
    workflow: giteaActionWorkflowSchema.optional(),
    workflow_run: giteaActionWorkflowRunSchema.optional(),
    repository: giteaRepositorySchema.extend({
      default_branch: z.string().optional(),
    }),
    sender: giteaUserSchema.optional(),
  })
  .passthrough();

export type GiteaWorkflowRunWebhook = z.infer<
  typeof giteaWorkflowRunWebhookSchema
>;

const giteaPushCommitSchema = z
  .object({
    id: z.string(),
    message: z.string(),
    url: z.string().optional(),
    author: giteaUserSchema
      .extend({
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export const giteaPushWebhookSchema = z
  .object({
    ref: z.string(),
    deleted: z.boolean().optional(),
    compare_url: z.string().nullable().optional(),
    commits: z.array(giteaPushCommitSchema),
    pusher: giteaUserSchema.extend({ name: z.string().optional() }).optional(),
    sender: giteaUserSchema.optional(),
    repository: giteaRepositorySchema.extend({
      default_branch: z.string().optional(),
    }),
  })
  .passthrough();

export type GiteaPushWebhook = z.infer<typeof giteaPushWebhookSchema>;
