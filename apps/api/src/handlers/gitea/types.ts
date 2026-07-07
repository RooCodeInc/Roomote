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
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    url: z.string().optional(),
    state: z.string().optional(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
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
