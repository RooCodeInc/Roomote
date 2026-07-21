import { z } from 'zod';

const adoIdentitySchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
  })
  .passthrough();

const adoProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const adoRepositorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    project: adoProjectSchema,
    remoteUrl: z.string().optional(),
    webUrl: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const adoCommitSchema = z
  .object({
    commitId: z.string().optional(),
  })
  .passthrough();

const adoLinkSchema = z
  .object({
    href: z.string().optional(),
  })
  .passthrough();

const adoPullRequestLinksSchema = z
  .object({
    web: adoLinkSchema.optional(),
  })
  .passthrough();
const adoCommentLinksSchema = z
  .object({
    self: adoLinkSchema.optional(),
    threads: adoLinkSchema.optional(),
  })
  .passthrough();

const adoPullRequestResourceSchema = z
  .object({
    repository: adoRepositorySchema,
    pullRequestId: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.string().optional(),
    isDraft: z.boolean().optional(),
    creationDate: z.string().optional(),
    closedDate: z.string().optional(),
    sourceRefName: z.string().optional(),
    targetRefName: z.string().optional(),
    createdBy: adoIdentitySchema.optional(),
    closedBy: adoIdentitySchema.optional(),
    lastMergeSourceCommit: adoCommitSchema.optional(),
    lastMergeTargetCommit: adoCommitSchema.optional(),
    commits: z.array(adoCommitSchema).optional(),
    url: z.string().optional(),
    _links: adoPullRequestLinksSchema.optional(),
  })
  .passthrough();

const adoPullRequestCommentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    parentCommentId: z.union([z.string(), z.number()]).optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
    author: adoIdentitySchema.optional(),
    content: z.string().optional(),
    commentType: z.string().optional(),
    _links: adoCommentLinksSchema.optional(),
  })
  .passthrough();

const adoPullRequestCommentResourceSchema = z
  .object({
    comment: adoPullRequestCommentSchema,
    pullRequest: adoPullRequestResourceSchema,
  })
  .passthrough();

const adoResourceContainerSchema = z
  .object({
    id: z.string().optional(),
    baseUrl: z.string().optional(),
  })
  .passthrough();

const adoResourceContainersSchema = z
  .object({
    account: adoResourceContainerSchema.optional(),
    collection: adoResourceContainerSchema.optional(),
    project: adoResourceContainerSchema.optional(),
  })
  .passthrough();

const adoWebhookBaseSchema = z
  .object({
    id: z.string().optional(),
    notificationId: z.union([z.string(), z.number()]).optional(),
    eventType: z.string(),
    publisherId: z.string().optional(),
    resourceContainers: adoResourceContainersSchema.optional(),
    createdDate: z.string().optional(),
  })
  .passthrough();

export const adoPullRequestWebhookSchema = z
  .object({ resource: adoPullRequestResourceSchema })
  .merge(adoWebhookBaseSchema);

export const adoPullRequestCommentWebhookSchema = z
  .object({
    resource: adoPullRequestCommentResourceSchema,
  })
  .merge(adoWebhookBaseSchema);

export type AdoPullRequestWebhook = z.infer<typeof adoPullRequestWebhookSchema>;
export type AdoPullRequestCommentWebhook = z.infer<
  typeof adoPullRequestCommentWebhookSchema
>;
export type AdoPullRequestResource = z.infer<
  typeof adoPullRequestResourceSchema
>;
export type AdoPullRequestComment = z.infer<typeof adoPullRequestCommentSchema>;
export type AdoIdentity = z.infer<typeof adoIdentitySchema>;

const adoWorkItemFieldsSchema = z
  .object({
    'System.Id': z.union([z.string(), z.number()]).optional(),
    'System.Title': z.string().optional(),
    'System.Description': z.string().nullable().optional(),
    'System.History': z.string().optional(),
    'System.TeamProject': z.string().optional(),
    'System.WorkItemType': z.string().optional(),
    'System.State': z.string().optional(),
    'System.ChangedBy': z.union([adoIdentitySchema, z.string()]).optional(),
    'System.CreatedBy': z.union([adoIdentitySchema, z.string()]).optional(),
  })
  .passthrough();

const adoWorkItemRevisionFieldSchema = z
  .object({
    oldValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
  })
  .passthrough();

const adoWorkItemResourceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    rev: z.union([z.string(), z.number()]).optional(),
    fields: adoWorkItemFieldsSchema.optional(),
    // Some Azure DevOps deployments deliver comment events in the
    // work-item-update shape with per-field old/new values.
    revision: z
      .object({
        fields: z.record(adoWorkItemRevisionFieldSchema).optional(),
        revisedBy: adoIdentitySchema.optional(),
      })
      .passthrough()
      .optional(),
    revisedBy: adoIdentitySchema.optional(),
    url: z.string().optional(),
    _links: z
      .object({
        html: adoLinkSchema.optional(),
        self: adoLinkSchema.optional(),
        web: adoLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const adoWorkItemCommentedWebhookSchema = z
  .object({
    resource: adoWorkItemResourceSchema,
    message: z
      .object({
        text: z.string().optional(),
        html: z.string().optional(),
        markdown: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .merge(adoWebhookBaseSchema);

export type AdoWorkItemCommentedWebhook = z.infer<
  typeof adoWorkItemCommentedWebhookSchema
>;
export type AdoWorkItemResource = z.infer<typeof adoWorkItemResourceSchema>;

const adoBuildDefinitionSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const adoBuildRepositorySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const adoBuildResourceSchema = z
  .object({
    id: z.number(),
    buildNumber: z.string().optional(),
    status: z.string().optional(),
    result: z.string().nullable().optional(),
    sourceBranch: z.string().optional(),
    sourceVersion: z.string().optional(),
    reason: z.string().optional(),
    url: z.string().optional(),
    definition: adoBuildDefinitionSchema.optional(),
    project: adoProjectSchema.optional(),
    repository: adoBuildRepositorySchema.optional(),
    _links: z
      .object({
        web: adoLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const adoBuildCompleteWebhookSchema = z
  .object({
    resource: adoBuildResourceSchema,
  })
  .merge(adoWebhookBaseSchema);

export type AdoBuildCompleteWebhook = z.infer<
  typeof adoBuildCompleteWebhookSchema
>;
