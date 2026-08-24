import { components } from '@octokit/openapi-webhooks-types';

type Schemas = components['schemas'];

/**
 * WebhookInstallation
 */

export type WebhookInstallation = Schemas['simple-installation'];

/**
 * WebhookUser
 */

export type WebhookUser = Schemas['simple-user'];

/**
 * WebhookRepository
 */

export type WebhookRepository = Schemas['repository-webhooks'];

/**
 * WebhookPullRequestOpened
 */

export type WebhookPullRequestOpened = Pick<
  Schemas['webhook-pull-request-opened'],
  'installation' | 'repository' | 'sender'
> & { pull_request: PullRequest };

/**
 * WebhookPullRequestReopened
 */

export type WebhookPullRequestReopened = Pick<
  Schemas['webhook-pull-request-reopened'],
  'installation' | 'repository' | 'pull_request' | 'sender'
>;

/**
 * WebhookPullRequestSynchronize
 */

export type WebhookPullRequestSynchronize = Pick<
  Schemas['webhook-pull-request-synchronize'],
  'installation' | 'repository' | 'pull_request' | 'sender'
>;

/**
 * WebhookPullRequestReadyForReview
 */

export type WebhookPullRequestReadyForReview = Pick<
  Schemas['webhook-pull-request-ready-for-review'],
  'installation' | 'repository' | 'pull_request' | 'sender'
>;

/**
 * WebhookPullRequestClosed
 */

export type WebhookPullRequestClosed = Pick<
  Schemas['webhook-pull-request-closed'],
  'installation' | 'repository' | 'pull_request' | 'sender'
>;

/**
 * PullRequest
 */

export type PullRequest =
  | Schemas['webhook-pull-request-opened']['pull_request']
  | Schemas['webhook-pull-request-reopened']['pull_request']
  | Schemas['webhook-pull-request-synchronize']['pull_request']
  | Schemas['webhook-pull-request-review-submitted']['pull_request'];

/**
 * WebhookIssueCommentCreated
 */

export type WebhookIssueCommentCreated =
  Schemas['webhook-issue-comment-created'];

/**
 * WebhookIssueCommentEdited
 */

export type WebhookIssueCommentEdited = Schemas['webhook-issue-comment-edited'];

/**
 * WebhookPullRequestCommentCreated
 */

export type WebhookPullRequestCommentCreated =
  Schemas['webhook-pull-request-review-comment-created'];

/**
 * WebhookPullRequestReviewSubmitted
 */

export type WebhookPullRequestReviewSubmitted =
  Schemas['webhook-pull-request-review-submitted'];

/**
 * WebhookCheckRunCompleted
 */

export type WebhookCheckRunCompleted = Schemas['webhook-check-run-completed'];

/**
 * WebhookTaskProperties
 */

export type WebhookTaskProperties = {
  userId: string | null | undefined;
  githubLogin: string | null | undefined;
  githubUserId: number | null | undefined;
};

/**
 * WebhookInstallationCreated
 */

export type WebhookInstallationCreated =
  Schemas['webhook-installation-created'];
