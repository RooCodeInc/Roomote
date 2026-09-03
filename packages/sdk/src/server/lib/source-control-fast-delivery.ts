import {
  createFastAgentTaskLauncher,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { and, db, eq, repositories } from '@roomote/db/server';
import { buildFastSessionReplyFooterText } from '@roomote/communication';
import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  linkedWorkItemProviderSchema,
  TaskPayloadKind,
  type FastAgentSourceControlConversation,
  type FastAgentSourceControlSurface,
} from '@roomote/types';

export type SourceControlDiscussionKind = 'pull' | 'issues';

export type SourceControlFastDiscussion = {
  provider: FastAgentSourceControlSurface;
  host: string;
  repositoryFullName: string;
  kind: SourceControlDiscussionKind;
  number: number;
  /** Review comment a reply threads under, when the mention came from one. */
  reviewCommentId?: string;
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
  return {
    surface: discussion.provider,
    workspaceId: `${discussion.host}/${discussion.repositoryFullName}`,
    conversationId: discussionId,
    replyTarget: {
      channelId: discussionId,
      ...(discussion.reviewCommentId
        ? { threadId: discussion.reviewCommentId }
        : {}),
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
  return {
    provider: conversation.surface,
    host,
    repositoryFullName,
    kind: match[1] as SourceControlDiscussionKind,
    number: Number(match[2]),
    ...(conversation.replyTarget.threadId
      ? { reviewCommentId: conversation.replyTarget.threadId }
      : {}),
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
            conversation: params.conversation,
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

export type SourceControlFastReplyPoster = (input: {
  discussion: SourceControlFastDiscussion;
  body: string;
}) => Promise<{ messageId: string }>;

/**
 * Delivery for one discussion: how replies post and how delegated tasks
 * find their target. Each provider supplies both from its own client.
 */
export type SourceControlFastDelivery = {
  postComment: SourceControlFastReplyPoster;
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
        return { messageId: String(response.data.id) };
      }
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: target.number,
        body,
      });
      return { messageId: String(response.data.id) };
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
    default:
      return null;
  }
}

/**
 * The reply surface a Session uses in a discussion: replies post as comments
 * with the Session footer, and tasks launch against the discussion's target.
 */
export function buildSourceControlFastAdapter(params: {
  conversation: FastAgentSourceControlConversation;
  delivery: SourceControlFastDelivery;
  userId: string;
  sessionId: string;
  onReplyPosted?: () => void;
}): {
  launchTask: LaunchFastAgentTask;
  postReply: (reply: { message: string }) => Promise<{ messageId: string }>;
} {
  const discussion = parseSourceControlFastConversation(params.conversation);
  return {
    launchTask: createFastAgentSourceControlTaskLauncher({
      userId: params.userId,
      conversation: params.conversation,
      resolveTarget: params.delivery.resolveTarget,
    }),
    postReply: async ({ message }) => {
      if (!discussion) {
        throw new Error(
          'The discussion for this Session could not be resolved.',
        );
      }
      const footer = buildFastSessionReplyFooterText({
        provider: discussion.provider,
        sessionId: params.sessionId,
      });
      const posted = await params.delivery.postComment({
        discussion,
        body: `${message}\n\n${footer}`,
      });
      params.onReplyPosted?.();
      return posted;
    },
  };
}
