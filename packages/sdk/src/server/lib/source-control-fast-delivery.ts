import { randomUUID } from 'node:crypto';

import {
  createFastAgentTaskLauncher,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { and, db, eq, repositories } from '@roomote/db/server';
import { buildFastSessionReplyFooterText } from '@roomote/communication';
import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  formatErrorForLog,
  linkedWorkItemProviderSchema,
  TaskPayloadKind,
  type FastAgentConversation,
  type FastAgentSourceControlConversation,
  type FastAgentSourceControlSurface,
} from '@roomote/types';

import {
  getSourceControlThreadCommentRecord,
  setSourceControlThreadCommentRecord,
} from './source-control-thread-comment-state';

export type SourceControlDiscussionKind = 'pull' | 'issues';

export type SourceControlFastDiscussion = {
  provider: FastAgentSourceControlSurface;
  host: string;
  repositoryFullName: string;
  kind: SourceControlDiscussionKind;
  number: number;
  /** Review comment a reply threads under, when the mention came from one. */
  reviewCommentId?: string;
  /**
   * The comment a reply answers inside that thread, for providers that
   * nest replies under a parent (Azure DevOps).
   */
  replyCommentId?: string;
};

/**
 * A pull request or issue discussion is one Fast conversation per provider:
 * the repository (with its host) is the workspace and the discussion is the
 * conversation. The review thread a reply should land in is a mutable reply
 * target, not part of the identity.
 */
export function buildSourceControlFastConversation(
  discussion: SourceControlFastDiscussion,
): FastAgentSourceControlConversation {
  const discussionId = `${discussion.kind}/${discussion.number}`;
  // The reply thread is one target field; a nested parent comment rides
  // along after a colon so both survive the reply target's single thread id.
  const threadId = discussion.reviewCommentId
    ? discussion.replyCommentId
      ? `${discussion.reviewCommentId}:${discussion.replyCommentId}`
      : discussion.reviewCommentId
    : undefined;
  return {
    surface: discussion.provider,
    workspaceId: `${discussion.host}/${discussion.repositoryFullName}`,
    conversationId: discussionId,
    replyTarget: {
      channelId: discussionId,
      ...(threadId ? { threadId } : {}),
    },
  };
}

export function parseSourceControlFastConversation(
  conversation: FastAgentSourceControlConversation,
): SourceControlFastDiscussion | null {
  const separator = conversation.workspaceId.indexOf('/');
  const host = conversation.workspaceId.slice(0, separator);
  const repositoryFullName = conversation.workspaceId.slice(separator + 1);
  const match = /^(pull|issues)\/(\d+)$/.exec(conversation.conversationId);
  if (separator <= 0 || !repositoryFullName || !match) {
    return null;
  }
  const [reviewCommentId, replyCommentId] =
    conversation.replyTarget.threadId?.split(':') ?? [];
  return {
    provider: conversation.surface,
    host,
    repositoryFullName,
    kind: match[1] as SourceControlDiscussionKind,
    number: Number(match[2]),
    ...(reviewCommentId ? { reviewCommentId } : {}),
    ...(replyCommentId ? { replyCommentId } : {}),
  };
}

/** The pull request or issue a delegated task is bound to. */
export type SourceControlFastLaunchTarget = {
  repositoryId?: string | null;
  branch?: string;
  pullRequest?: {
    url: string;
    title?: string | null;
    sha?: string | null;
  };
  issue?: {
    identifier: string;
    url?: string;
    title?: string;
  };
};

/**
 * Delegated work from a discussion is a standard task on that repository:
 * on a pull request it checks out the head branch and is linked to the PR,
 * on an issue it links the issue. The Session owns every reply into the
 * discussion; the child only reports to its orchestrator.
 */
export function createFastAgentSourceControlTaskLauncher(params: {
  userId: string;
  conversation: FastAgentSourceControlConversation;
  /**
   * The Session's home conversation when it differs from the discussion (a
   * Slack Session answering a mention on the pull request its task opened).
   * The child attaches to that home so its lifecycle events reach the Session.
   */
  parentConversation?: FastAgentConversation;
  resolveTarget: () => Promise<SourceControlFastLaunchTarget>;
}): LaunchFastAgentTask {
  const discussion = parseSourceControlFastConversation(params.conversation);
  let targetPromise: Promise<SourceControlFastLaunchTarget> | undefined;
  const loadTarget = () => (targetPromise ??= params.resolveTarget());

  return async (input) => {
    if (!discussion) {
      return {
        success: false,
        error: 'The discussion for this Session could not be resolved.',
      };
    }
    const target = await loadTarget();
    // A pull request child must check out the PR head; without a resolved
    // branch it would edit the environment's default branch instead.
    if (target.pullRequest && !target.branch) {
      return {
        success: false,
        error:
          'The pull request head branch could not be resolved, so the task was not started.',
      };
    }
    // Only providers whose issues can be linked as work items record one.
    const linkedProvider = linkedWorkItemProviderSchema.safeParse(
      discussion.provider,
    );
    const linkedIssue =
      target.issue && linkedProvider.success
        ? {
            provider: linkedProvider.data,
            identifier: target.issue.identifier,
            repository: discussion.repositoryFullName,
            ...(target.issue.url ? { url: target.issue.url } : {}),
            ...(target.issue.title ? { title: target.issue.title } : {}),
          }
        : null;
    const launch = createFastAgentTaskLauncher({
      userId: params.userId,
      surface: discussion.provider,
      taskUrlCampaign: 'fast-delegation',
      ...(target.pullRequest
        ? {
            prLinkage: {
              provider: discussion.provider,
              host: discussion.host,
              ...(target.repositoryId
                ? { repositoryId: target.repositoryId }
                : {}),
              repository: discussion.repositoryFullName,
              prNumber: discussion.number,
              prUrl: target.pullRequest.url,
              prTitle: target.pullRequest.title ?? null,
              prSha: target.pullRequest.sha ?? null,
            },
          }
        : {}),
      buildTask: ({
        prompt,
        environmentId,
        branch,
        model,
        reasoningEffort,
        parentSessionId,
      }) => ({
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: discussion.repositoryFullName,
          description: prompt,
          sourceControlProvider: discussion.provider,
          sourceControlHost: discussion.host,
          ...((branch ?? target.branch)
            ? { branch: branch ?? target.branch }
            : {}),
          ...(linkedIssue ? { linkedWorkItems: [linkedIssue] } : {}),
          ...buildFastAgentChildTaskMetadata({
            sessionId: parentSessionId,
            conversation: params.parentConversation ?? params.conversation,
          }),
          ...(environmentId && environmentId !== ALL_REPOSITORIES
            ? { environmentId }
            : {}),
          ...(model
            ? { harnessModelOverrides: { 'opencode-server': model } }
            : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      }),
    });
    return launch(input);
  };
}

/**
 * The comment a turn answers, quoted exactly the way GitHub's own
 * "Quote reply" does: every line of the original prefixed with "> ",
 * nothing added.
 */
export function buildSourceControlReplyQuote(params: {
  text: string;
}): string | null {
  if (!params.text.trim()) {
    return null;
  }
  // Quote the text verbatim: indentation and blank lines are meaningful
  // Markdown (code blocks, paragraph breaks) and GitHub preserves them.
  return params.text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

export type SourceControlPostedComment = {
  messageId: string;
  /**
   * Replaces the comment's whole body in place. A turn's later replies edit
   * the comment it opened with instead of stacking new comments on the
   * discussion.
   */
  update?: (body: string) => Promise<void>;
};

export type SourceControlFastReplyPoster = (input: {
  discussion: SourceControlFastDiscussion;
  body: string;
}) => Promise<SourceControlPostedComment>;

/**
 * Delivery for one discussion: how replies post and how delegated tasks
 * find their target. Each provider supplies both from its own client.
 */
export type SourceControlFastDelivery = {
  postComment: SourceControlFastReplyPoster;
  /**
   * Rebuilds an in-place editor from a previously posted comment's message
   * id, for turns that resume in a fresh process and only carry the id.
   */
  updateCommentById?: (input: {
    discussion: SourceControlFastDiscussion;
    messageId: string;
    body: string;
  }) => Promise<void>;
  resolveTarget: () => Promise<SourceControlFastLaunchTarget>;
};

async function findGitHubRepository(discussion: SourceControlFastDiscussion) {
  const rows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'github'),
      eq(repositories.fullName, discussion.repositoryFullName),
      eq(repositories.isActive, true),
    ),
    with: { githubInstallation: true },
  });
  return (
    rows.find((row) => (row.host ?? 'github.com') === discussion.host) ??
    rows.find((row) => !row.host) ??
    null
  );
}

async function buildGitHubFastDelivery(
  discussion: SourceControlFastDiscussion,
): Promise<SourceControlFastDelivery | null> {
  const repository = await findGitHubRepository(discussion);
  if (!repository?.githubInstallation) {
    return null;
  }
  const { getInstallationOctokit } = await import('@roomote/github');
  const octokit = await getInstallationOctokit(repository.githubInstallation);
  const [owner, repo] = discussion.repositoryFullName.split('/');
  if (!owner || !repo) {
    return null;
  }

  return {
    postComment: async ({ discussion: target, body }) => {
      if (target.kind === 'pull' && target.reviewCommentId) {
        const response = await octokit.request(
          'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
          {
            owner,
            repo,
            pull_number: target.number,
            comment_id: Number(target.reviewCommentId),
            body,
          },
        );
        const commentId = response.data.id;
        return {
          messageId: String(commentId),
          update: async (nextBody) => {
            await octokit.rest.pulls.updateReviewComment({
              owner,
              repo,
              comment_id: commentId,
              body: nextBody,
            });
          },
        };
      }
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: target.number,
        body,
      });
      const commentId = response.data.id;
      return {
        messageId: String(commentId),
        update: async (nextBody) => {
          await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: commentId,
            body: nextBody,
          });
        },
      };
    },
    updateCommentById: async ({ discussion: target, messageId, body }) => {
      const commentId = Number(messageId);
      if (!Number.isInteger(commentId)) {
        throw new Error(`Not an editable GitHub comment id: ${messageId}`);
      }
      if (target.kind === 'pull' && target.reviewCommentId) {
        await octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: commentId,
          body,
        });
        return;
      }
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
    },
    resolveTarget: async () => {
      if (discussion.kind === 'issues') {
        const issue = await octokit.rest.issues
          .get({ owner, repo, issue_number: discussion.number })
          .then((response) => response.data)
          .catch(() => null);
        return {
          repositoryId: repository.id,
          issue: {
            identifier: String(discussion.number),
            url:
              issue?.html_url ??
              `https://${discussion.host}/${discussion.repositoryFullName}/issues/${discussion.number}`,
            ...(issue?.title ? { title: issue.title } : {}),
          },
        };
      }
      const pullRequest = await octokit.rest.pulls
        .get({ owner, repo, pull_number: discussion.number })
        .then((response) => response.data)
        .catch(() => null);
      return {
        repositoryId: repository.id,
        ...(pullRequest?.head?.ref ? { branch: pullRequest.head.ref } : {}),
        pullRequest: {
          url:
            pullRequest?.html_url ??
            `https://${discussion.host}/${discussion.repositoryFullName}/pull/${discussion.number}`,
          title: pullRequest?.title ?? null,
          sha: pullRequest?.head?.sha ?? null,
        },
      };
    },
  };
}

/**
 * Resolves the provider client for a discussion. Null when the repository is
 * not connected on this deployment or the provider has no Fast delivery yet.
 */
export async function buildSourceControlFastDelivery(
  conversation: FastAgentSourceControlConversation,
): Promise<SourceControlFastDelivery | null> {
  const discussion = parseSourceControlFastConversation(conversation);
  if (!discussion) {
    return null;
  }
  switch (discussion.provider) {
    case 'github':
      return buildGitHubFastDelivery(discussion);
    case 'gitlab':
      return buildGitLabFastDelivery(discussion);
    case 'bitbucket':
      return buildBitbucketFastDelivery(discussion);
    case 'gitea':
      return buildGiteaFastDelivery(discussion);
    case 'ado':
      return buildAdoFastDelivery(discussion);
  }
}

async function findProviderRepository(discussion: SourceControlFastDiscussion) {
  const rows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, discussion.provider),
      eq(repositories.fullName, discussion.repositoryFullName),
      eq(repositories.isActive, true),
    ),
  });
  return (
    rows.find((row) => row.host === discussion.host) ??
    rows.find((row) => !row.host) ??
    null
  );
}

function pullRequestPageUrl(discussion: SourceControlFastDiscussion): string {
  const base = `https://${discussion.host}/${discussion.repositoryFullName}`;
  switch (discussion.provider) {
    case 'github':
      return `${base}/${discussion.kind === 'pull' ? 'pull' : 'issues'}/${discussion.number}`;
    case 'gitlab':
      return `${base}/-/${discussion.kind === 'pull' ? 'merge_requests' : 'issues'}/${discussion.number}`;
    case 'bitbucket':
      return `${base}/pull-requests/${discussion.number}`;
    case 'ado': {
      // Azure DevOps names repositories organization/project/repository; a
      // pull request lives under the repository's _git area and a work item
      // under the project.
      const [organization, project, repository, ...extra] =
        discussion.repositoryFullName.split('/');
      if (!organization || !project || !repository || extra.length > 0) {
        return `${base}/${discussion.kind === 'pull' ? 'pullrequest' : '_workitems/edit'}/${discussion.number}`;
      }
      const projectBase = `https://${discussion.host}/${organization}/${project}`;
      return discussion.kind === 'pull'
        ? `${projectBase}/_git/${repository}/pullrequest/${discussion.number}`
        : `${projectBase}/_workitems/edit/${discussion.number}`;
    }
    default:
      return `${base}/${discussion.kind === 'pull' ? 'pulls' : 'issues'}/${discussion.number}`;
  }
}

/** Public page of a discussion, derived from its identity when the provider's own URL is not at hand. */
export const buildSourceControlDiscussionUrl = pullRequestPageUrl;

async function buildGitLabFastDelivery(
  discussion: SourceControlFastDiscussion,
): Promise<SourceControlFastDelivery | null> {
  const repository = await findProviderRepository(discussion);
  if (!repository) {
    return null;
  }
  const {
    createGitLabIssueNote,
    createGitLabMergeRequestNote,
    getGitLabMergeRequest,
    updateGitLabNote,
  } = await import('@roomote/gitlab');
  return {
    postComment: async ({ discussion: target, body }) => {
      const noteableType =
        target.kind === 'pull'
          ? ('merge_requests' as const)
          : ('issues' as const);
      const note =
        target.kind === 'pull'
          ? await createGitLabMergeRequestNote({
              projectId: target.repositoryFullName,
              mergeRequestIid: target.number,
              body,
            })
          : await createGitLabIssueNote({
              projectId: target.repositoryFullName,
              issueIid: target.number,
              body,
            });
      return {
        messageId: String(note.id),
        update: async (nextBody) => {
          await updateGitLabNote({
            projectId: target.repositoryFullName,
            noteableType,
            noteableIid: target.number,
            noteId: note.id,
            body: nextBody,
          });
        },
      };
    },
    updateCommentById: async ({ discussion: target, messageId, body }) => {
      await updateGitLabNote({
        projectId: target.repositoryFullName,
        noteableType: target.kind === 'pull' ? 'merge_requests' : 'issues',
        noteableIid: target.number,
        noteId: Number(messageId),
        body,
      });
    },
    resolveTarget: async () => {
      if (discussion.kind === 'issues') {
        return {
          repositoryId: repository.id,
          issue: {
            identifier: String(discussion.number),
            url: pullRequestPageUrl(discussion),
          },
        };
      }
      const mergeRequest = await getGitLabMergeRequest({
        projectId: discussion.repositoryFullName,
        mergeRequestIid: discussion.number,
      }).catch(() => null);
      return {
        repositoryId: repository.id,
        ...(mergeRequest?.source_branch
          ? { branch: mergeRequest.source_branch }
          : {}),
        pullRequest: {
          url: mergeRequest?.web_url ?? pullRequestPageUrl(discussion),
          title: mergeRequest?.title ?? null,
          sha: mergeRequest?.sha ?? null,
        },
      };
    },
  };
}

async function buildBitbucketFastDelivery(
  discussion: SourceControlFastDiscussion,
): Promise<SourceControlFastDelivery | null> {
  const repository = await findProviderRepository(discussion);
  if (!repository || discussion.kind !== 'pull') {
    return null;
  }
  const {
    createBitbucketPullRequestComment,
    getBitbucketPullRequest,
    updateBitbucketPullRequestComment,
  } = await import('@roomote/bitbucket');
  return {
    postComment: async ({ discussion: target, body }) => {
      const comment = await createBitbucketPullRequestComment({
        repositoryFullName: target.repositoryFullName,
        pullRequestNumber: target.number,
        body,
      });
      return {
        messageId: String(comment.id),
        update: async (nextBody) => {
          await updateBitbucketPullRequestComment({
            repositoryFullName: target.repositoryFullName,
            pullRequestNumber: target.number,
            commentId: comment.id,
            body: nextBody,
          });
        },
      };
    },
    updateCommentById: async ({ discussion: target, messageId, body }) => {
      await updateBitbucketPullRequestComment({
        repositoryFullName: target.repositoryFullName,
        pullRequestNumber: target.number,
        commentId: Number(messageId),
        body,
      });
    },
    resolveTarget: async () => {
      const pullRequest = await getBitbucketPullRequest({
        repositoryFullName: discussion.repositoryFullName,
        pullRequestNumber: discussion.number,
      }).catch(() => null);
      return {
        repositoryId: repository.id,
        ...(pullRequest?.source?.branch?.name
          ? { branch: pullRequest.source.branch.name }
          : {}),
        pullRequest: {
          url: pullRequest?.links?.html?.href ?? pullRequestPageUrl(discussion),
          title: pullRequest?.title ?? null,
          sha: pullRequest?.source?.commit?.hash ?? null,
        },
      };
    },
  };
}

async function buildGiteaFastDelivery(
  discussion: SourceControlFastDiscussion,
): Promise<SourceControlFastDelivery | null> {
  const repository = await findProviderRepository(discussion);
  if (!repository) {
    return null;
  }
  const {
    createGiteaIssueComment,
    createGiteaPullRequestComment,
    getGiteaPullRequest,
    updateGiteaComment,
  } = await import('@roomote/gitea');
  return {
    postComment: async ({ discussion: target, body }) => {
      const comment =
        target.kind === 'pull'
          ? await createGiteaPullRequestComment({
              repositoryFullName: target.repositoryFullName,
              pullRequestNumber: target.number,
              body,
            })
          : await createGiteaIssueComment({
              repositoryFullName: target.repositoryFullName,
              issueNumber: target.number,
              body,
            });
      return {
        messageId: String(comment.id),
        update: async (nextBody) => {
          await updateGiteaComment({
            repositoryFullName: target.repositoryFullName,
            commentId: comment.id,
            body: nextBody,
          });
        },
      };
    },
    updateCommentById: async ({ discussion: target, messageId, body }) => {
      await updateGiteaComment({
        repositoryFullName: target.repositoryFullName,
        commentId: Number(messageId),
        body,
      });
    },
    resolveTarget: async () => {
      if (discussion.kind === 'issues') {
        return {
          repositoryId: repository.id,
          issue: {
            identifier: String(discussion.number),
            url: pullRequestPageUrl(discussion),
          },
        };
      }
      const pullRequest = await getGiteaPullRequest({
        repositoryFullName: discussion.repositoryFullName,
        pullRequestNumber: discussion.number,
      }).catch(() => null);
      return {
        repositoryId: repository.id,
        ...(pullRequest?.head?.ref ? { branch: pullRequest.head.ref } : {}),
        pullRequest: {
          url: pullRequest?.html_url ?? pullRequestPageUrl(discussion),
          title: pullRequest?.title ?? null,
          sha: pullRequest?.head?.sha ?? null,
        },
      };
    },
  };
}

async function buildAdoFastDelivery(
  discussion: SourceControlFastDiscussion,
): Promise<SourceControlFastDelivery | null> {
  const repository = await findProviderRepository(discussion);
  if (!repository) {
    return null;
  }
  const {
    createAdoPullRequestComment,
    createAdoWorkItemComment,
    getAdoPullRequest,
    listAdoRepositories,
    parseAdoRepositoryFullName,
    updateAdoPullRequestComment,
    updateAdoWorkItemComment,
  } = await import('@roomote/ado');
  const parsed = parseAdoRepositoryFullName(discussion.repositoryFullName);
  // Azure DevOps addresses pull requests by repository GUID, which the
  // repository row does not keep; resolve it once from the organization.
  let repositoryIdPromise: Promise<string | null> | undefined;
  const resolveAdoRepositoryId = () =>
    (repositoryIdPromise ??= listAdoRepositories({
      organization: parsed.organization,
    })
      .then(
        (repos) =>
          repos.find(
            (candidate) =>
              candidate.project.name.toLowerCase() ===
                parsed.project.toLowerCase() &&
              candidate.name.toLowerCase() === parsed.repository.toLowerCase(),
          )?.id ?? null,
      )
      .catch(() => null));

  return {
    postComment: async ({ discussion: target, body }) => {
      if (target.kind === 'issues') {
        const comment = await createAdoWorkItemComment({
          project: parsed.project,
          workItemId: target.number,
          body,
          organization: parsed.organization,
        });
        return {
          messageId: comment.commentId
            ? `wit:${comment.commentId}`
            : `ado-work-item-comment:${randomUUID()}`,
          ...(comment.commentId
            ? {
                update: async (nextBody: string) => {
                  await updateAdoWorkItemComment({
                    project: parsed.project,
                    workItemId: target.number,
                    commentId: comment.commentId!,
                    body: nextBody,
                    organization: parsed.organization,
                  });
                },
              }
            : {}),
        };
      }
      const adoRepositoryId = await resolveAdoRepositoryId();
      if (!adoRepositoryId) {
        throw new Error(
          `Azure DevOps repository ${target.repositoryFullName} could not be resolved.`,
        );
      }
      const comment = await createAdoPullRequestComment({
        repositoryFullName: target.repositoryFullName,
        repositoryId: adoRepositoryId,
        pullRequestNumber: target.number,
        ...(target.reviewCommentId ? { threadId: target.reviewCommentId } : {}),
        ...(target.replyCommentId
          ? { parentCommentId: target.replyCommentId }
          : {}),
        body,
        organization: parsed.organization,
      });
      return {
        messageId: comment.commentId
          ? `thread:${comment.threadId}:${comment.commentId}`
          : `ado-thread:${comment.threadId}`,
        ...(comment.commentId
          ? {
              update: async (nextBody: string) => {
                await updateAdoPullRequestComment({
                  repositoryFullName: target.repositoryFullName,
                  repositoryId: adoRepositoryId,
                  pullRequestNumber: target.number,
                  threadId: comment.threadId,
                  commentId: comment.commentId!,
                  body: nextBody,
                  organization: parsed.organization,
                });
              },
            }
          : {}),
      };
    },
    updateCommentById: async ({ discussion: target, messageId, body }) => {
      const witMatch = /^wit:(.+)$/.exec(messageId);
      if (witMatch) {
        await updateAdoWorkItemComment({
          project: parsed.project,
          workItemId: target.number,
          commentId: witMatch[1]!,
          body,
          organization: parsed.organization,
        });
        return;
      }
      const threadMatch = /^thread:([^:]+):(.+)$/.exec(messageId);
      if (!threadMatch) {
        throw new Error(
          `Not an editable Azure DevOps comment id: ${messageId}`,
        );
      }
      const adoRepositoryId = await resolveAdoRepositoryId();
      if (!adoRepositoryId) {
        throw new Error(
          `Azure DevOps repository ${target.repositoryFullName} could not be resolved.`,
        );
      }
      await updateAdoPullRequestComment({
        repositoryFullName: target.repositoryFullName,
        repositoryId: adoRepositoryId,
        pullRequestNumber: target.number,
        threadId: threadMatch[1]!,
        commentId: threadMatch[2]!,
        body,
        organization: parsed.organization,
      });
    },
    resolveTarget: async () => {
      if (discussion.kind === 'issues') {
        return {
          repositoryId: repository.id,
          issue: {
            identifier: String(discussion.number),
            url: `https://${discussion.host}/${parsed.organization}/${parsed.project}/_workitems/edit/${discussion.number}`,
          },
        };
      }
      const adoRepositoryId = await resolveAdoRepositoryId();
      const pullRequest = adoRepositoryId
        ? await getAdoPullRequest({
            repositoryId: adoRepositoryId,
            pullRequestNumber: discussion.number,
            organization: parsed.organization,
          }).catch(() => null)
        : null;
      const details = pullRequest as {
        title?: string;
        sourceRefName?: string;
        lastMergeSourceCommit?: { commitId?: string };
        repository?: { webUrl?: string };
      } | null;
      const branch = details?.sourceRefName?.replace(/^refs\/heads\//, '');
      return {
        repositoryId: repository.id,
        ...(branch ? { branch } : {}),
        pullRequest: {
          url: details?.repository?.webUrl
            ? `${details.repository.webUrl}/pullrequest/${discussion.number}`
            : `https://${discussion.host}/${parsed.organization}/${parsed.project}/_git/${parsed.repository}/pullrequest/${discussion.number}`,
          title: details?.title ?? null,
          sha: details?.lastMergeSourceCommit?.commitId ?? null,
        },
      };
    },
  };
}

/**
 * The reply surface a Session uses in a discussion: replies post as comments
 * with the Session footer, and tasks launch against the discussion's target.
 *
 * A turn owns one comment: the first reply opens it and later replies append
 * to it by editing in place, so a turn never stacks comments on the
 * discussion. On the discussion's main thread the footer is rendered once, at
 * the bottom, on every edit. Inside a review thread there is no footer: the
 * thread is a conversation about one finding, and the Session link belongs
 * on the top-level comment, not on every reply. A review thread also holds
 * one Roomote comment per human message: a turn that reports on delegated
 * work (`continuesThreadComment`) extends the comment the last human turn
 * opened there instead of adding another.
 */
export function buildSourceControlFastAdapter(params: {
  conversation: FastAgentSourceControlConversation;
  delivery: SourceControlFastDelivery;
  userId: string;
  sessionId: string;
  /**
   * The Session's home conversation when the discussion is not its own (see
   * createFastAgentSourceControlTaskLauncher). Delegated children attach there.
   */
  parentConversation?: FastAgentConversation;
  /**
   * Blockquote of the message this turn answers; opens the turn's comment on
   * the discussion's main thread. Inside a review thread the reply already
   * sits under the comment it answers, so the quote is dropped there.
   */
  quote?: string | null;
  /**
   * True for a turn no human wrote (a delegated task reporting back). In a
   * review thread it appends to the comment the last human turn opened.
   */
  continuesThreadComment?: boolean;
  onReplyPosted?: () => void;
}): {
  launchTask: LaunchFastAgentTask;
  postReply: (reply: { message: string }) => Promise<{ messageId: string }>;
  replaceReply?: (
    handle: { messageId: string },
    reply: { message: string },
  ) => Promise<{ messageId: string }>;
} {
  const discussion = parseSourceControlFastConversation(params.conversation);
  const threadId = params.conversation.replyTarget.threadId;
  const threaded = Boolean(discussion?.reviewCommentId && threadId);
  const footer =
    discussion && !threaded
      ? buildFastSessionReplyFooterText({
          provider: discussion.provider,
          sessionId: params.sessionId,
        })
      : null;
  const quote = threaded ? null : params.quote;
  let turnComment: SourceControlPostedComment | null = null;
  let turnBody = '';
  const renderBody = () => (footer ? `${turnBody}\n\n${footer}` : turnBody);
  const editorFor = (messageId: string): SourceControlPostedComment => ({
    messageId,
    ...(params.delivery.updateCommentById && discussion
      ? {
          update: (nextBody: string) =>
            params.delivery.updateCommentById!({
              discussion,
              messageId,
              body: nextBody,
            }),
        }
      : {}),
  });
  // The thread's comment record is a best-effort nicety: losing it costs one
  // extra comment, never the reply.
  const rememberThreadComment = async () => {
    if (!threaded || !threadId || !turnComment) {
      return;
    }
    await setSourceControlThreadCommentRecord(params.sessionId, threadId, {
      messageId: turnComment.messageId,
      body: turnBody,
    }).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to remember the review thread comment: ${formatErrorForLog(error)}`,
      );
    });
  };
  const adoptThreadComment = async (): Promise<boolean> => {
    if (
      !threaded ||
      !threadId ||
      !params.continuesThreadComment ||
      !params.delivery.updateCommentById
    ) {
      return false;
    }
    const record = await getSourceControlThreadCommentRecord(
      params.sessionId,
      threadId,
    ).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to look up the review thread comment: ${formatErrorForLog(error)}`,
      );
      return null;
    });
    if (!record) {
      return false;
    }
    turnComment = editorFor(record.messageId);
    turnBody = record.body;
    return true;
  };
  return {
    launchTask: createFastAgentSourceControlTaskLauncher({
      userId: params.userId,
      conversation: params.conversation,
      ...(params.parentConversation
        ? { parentConversation: params.parentConversation }
        : {}),
      resolveTarget: params.delivery.resolveTarget,
    }),
    postReply: async ({ message }) => {
      if (!discussion) {
        throw new Error(
          'The discussion for this Session could not be resolved.',
        );
      }
      if (!turnComment) {
        await adoptThreadComment();
      }
      if (turnComment?.update) {
        turnBody = `${turnBody}\n\n${message}`;
        await turnComment.update(renderBody());
        await rememberThreadComment();
        params.onReplyPosted?.();
        return { messageId: turnComment.messageId };
      }
      turnBody = quote ? `${quote}\n\n${message}` : message;
      turnComment = await params.delivery.postComment({
        discussion,
        body: renderBody(),
      });
      await rememberThreadComment();
      params.onReplyPosted?.();
      return { messageId: turnComment.messageId };
    },
    ...(params.delivery.updateCommentById && discussion
      ? {
          // A resumed turn only carries the prior comment's id: rebuild the
          // editor from it, replace the comment's body, and adopt it as the
          // turn's comment so later replies keep appending in place.
          replaceReply: async ({ messageId }, { message }) => {
            turnComment = editorFor(messageId);
            turnBody = message;
            await turnComment.update!(renderBody());
            await rememberThreadComment();
            params.onReplyPosted?.();
            return { messageId };
          },
        }
      : {}),
  };
}
