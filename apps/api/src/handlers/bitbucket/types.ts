import { z } from 'zod';

const bitbucketUserSchema = z
  .object({
    uuid: z.string().optional(),
    account_id: z.string().optional(),
    username: z.string().optional(),
    nickname: z.string().optional(),
    display_name: z.string().optional(),
  })
  .passthrough();

const bitbucketHtmlLinkSchema = z
  .object({
    href: z.string().optional(),
  })
  .passthrough();

const bitbucketRepositorySchema = z
  .object({
    uuid: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    full_name: z.string(),
    links: z
      .object({
        html: bitbucketHtmlLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const bitbucketBranchSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const bitbucketCommitSchema = z
  .object({
    hash: z.string().optional(),
  })
  .passthrough();

const bitbucketPullRequestEndpointSchema = z
  .object({
    branch: bitbucketBranchSchema.optional(),
    commit: bitbucketCommitSchema.optional(),
  })
  .passthrough();

const bitbucketPullRequestSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string().optional(),
    draft: z.boolean().optional(),
    source: bitbucketPullRequestEndpointSchema.optional(),
    destination: bitbucketPullRequestEndpointSchema.optional(),
    author: bitbucketUserSchema.optional(),
    links: z
      .object({
        html: bitbucketHtmlLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const bitbucketPullRequestWebhookSchema = z
  .object({
    pullrequest: bitbucketPullRequestSchema,
    repository: bitbucketRepositorySchema,
    actor: bitbucketUserSchema.optional(),
  })
  .passthrough();

export type BitbucketPullRequestWebhook = z.infer<
  typeof bitbucketPullRequestWebhookSchema
>;

const bitbucketCommentSchema = z
  .object({
    id: z.number().optional(),
    content: z
      .object({
        raw: z.string().optional(),
        markup: z.string().optional(),
        html: z.string().optional(),
      })
      .passthrough()
      .optional(),
    user: bitbucketUserSchema.optional(),
    links: z
      .object({
        html: bitbucketHtmlLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const bitbucketPullRequestCommentWebhookSchema = z
  .object({
    pullrequest: bitbucketPullRequestSchema,
    comment: bitbucketCommentSchema,
    repository: bitbucketRepositorySchema,
    actor: bitbucketUserSchema.optional(),
  })
  .passthrough();

export type BitbucketPullRequestCommentWebhook = z.infer<
  typeof bitbucketPullRequestCommentWebhookSchema
>;

export type BitbucketWebhookUser = z.infer<typeof bitbucketUserSchema>;

export function getBitbucketPullRequestNumber(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): number {
  return pullRequest.id;
}

export function getBitbucketPullRequestHeadSha(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): string {
  return pullRequest.source?.commit?.hash ?? '';
}

export function getBitbucketPullRequestHeadRef(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): string | undefined {
  return pullRequest.source?.branch?.name;
}

export function getBitbucketPullRequestBaseRef(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): string | undefined {
  return pullRequest.destination?.branch?.name;
}

export function getBitbucketPullRequestBaseSha(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): string | undefined {
  return pullRequest.destination?.commit?.hash;
}

export function getBitbucketPullRequestUrl(
  payload: Pick<BitbucketPullRequestWebhook, 'pullrequest' | 'repository'>,
): string {
  return (
    payload.pullrequest.links?.html?.href ??
    `https://bitbucket.org/${payload.repository.full_name}/pull-requests/${payload.pullrequest.id}`
  );
}

export function getBitbucketCommentBody(
  comment: BitbucketPullRequestCommentWebhook['comment'],
): string {
  return comment.content?.raw ?? '';
}

export function getBitbucketRepositoryExternalId(
  repository: BitbucketPullRequestWebhook['repository'],
): string {
  return String(repository.uuid ?? repository.id ?? repository.full_name);
}

export function isBitbucketPullRequestMerged(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): boolean {
  return pullRequest.state?.toUpperCase() === 'MERGED';
}

export function isBitbucketPullRequestClosed(
  pullRequest: BitbucketPullRequestWebhook['pullrequest'],
): boolean {
  const state = pullRequest.state?.toUpperCase();
  return state === 'MERGED' || state === 'DECLINED' || state === 'SUPERSEDED';
}
