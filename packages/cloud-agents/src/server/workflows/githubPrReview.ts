import {
  type GithubPullRequestReviewOpenTask,
  getSkillCommandDelimiter,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  createIssueComment,
  Cli as GitHubCli,
  Schemas as GitHubSchemas,
  updateIssueComment,
} from '@roomote/github';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

import {
  buildGithubCommentActionLink,
  buildStructuredTaskRequest,
  findReusableReviewSummaryComment,
  getPrDetails,
  getIssueDetails,
  getDiff,
  getReviewComments,
  getIssueComments,
  formatChangedFiles,
} from './utils';
import {
  getGitHubLinkedWorkItemsFromClosingIssues,
  mergeLinkedWorkItems,
} from './pr-linked-work-items';
import { resolveLinkedTaskReviewHandoff } from './resolve-linked-task-review-handoff';
import {
  buildInProgressReviewSummaryBody,
  buildReviewSummaryBody,
} from './githubPrReviewComment';
import { standardTask } from './standardTask';

function buildGitLabMergeRequestReviewPrompt({
  cloudTask,
  cloudJobUrl,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
}): string {
  const {
    payload: {
      repo: fullName,
      prNumber,
      prTitle,
      prUrl,
      headSha,
      branchName,
      targetBranch,
    },
  } = cloudTask;
  const delimiter = getSkillCommandDelimiter(cloudTask.harness);

  return buildStructuredTaskRequest({
    command: `${delimiter}review-code`,
    taskContext: {
      repository: fullName,
      source_control_provider: 'gitlab',
      merge_request_number: prNumber,
      merge_request_title: prTitle,
      merge_request_url: prUrl,
      source_branch: branchName,
      target_branch: targetBranch,
      current_head_sha: headSha || 'unknown',
      task_link_see: `[See task](${cloudJobUrl})`,
      review_scope:
        'Review only the GitLab merge request changes. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the diff with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
      suggested_diff_commands: [
        targetBranch
          ? `git fetch origin ${targetBranch} && git diff origin/${targetBranch}...HEAD`
          : 'git diff origin/HEAD...HEAD',
        headSha ? `git show --stat ${headSha}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  });
}

function gitLabMergeRequestReview({
  cloudTask,
  cloudJobUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}) {
  const prompt = buildGitLabMergeRequestReviewPrompt({
    cloudTask,
    cloudJobUrl,
  });

  return standardTask({
    description: prompt,
    repo: cloudTask.payload.repo,
    taskSurface: 'gitlab',
    cloudJobUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: cloudTask.payload.linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });
}

function buildGiteaPullRequestReviewPrompt({
  cloudTask,
  cloudJobUrl,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
}): string {
  const {
    payload: {
      repo: fullName,
      prNumber,
      prTitle,
      prUrl,
      headSha,
      branchName,
      targetBranch,
    },
  } = cloudTask;
  const delimiter = getSkillCommandDelimiter(cloudTask.harness);

  return buildStructuredTaskRequest({
    command: `${delimiter}review-code`,
    taskContext: {
      repository: fullName,
      source_control_provider: 'gitea',
      pull_request_number: prNumber,
      pull_request_title: prTitle,
      pull_request_url: prUrl,
      source_branch: branchName,
      target_branch: targetBranch,
      current_head_sha: headSha || 'unknown',
      task_link_see: `[See task](${cloudJobUrl})`,
      review_scope:
        'Review only the Gitea pull request changes. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the diff with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
      suggested_diff_commands: [
        targetBranch
          ? `git fetch origin ${targetBranch} && git diff origin/${targetBranch}...HEAD`
          : 'git diff origin/HEAD...HEAD',
        headSha ? `git show --stat ${headSha}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  });
}

function giteaPullRequestReview({
  cloudTask,
  cloudJobUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}) {
  const prompt = buildGiteaPullRequestReviewPrompt({
    cloudTask,
    cloudJobUrl,
  });

  return standardTask({
    description: prompt,
    repo: cloudTask.payload.repo,
    taskSurface: 'gitea',
    cloudJobUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: cloudTask.payload.linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });
}

function buildAdoPullRequestReviewPrompt({
  cloudTask,
  cloudJobUrl,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
}): string {
  const {
    payload: {
      repo: fullName,
      prNumber,
      prTitle,
      prUrl,
      headSha,
      branchName,
      targetBranch,
    },
  } = cloudTask;
  const delimiter = getSkillCommandDelimiter(cloudTask.harness);

  return buildStructuredTaskRequest({
    command: `${delimiter}review-code`,
    taskContext: {
      repository: fullName,
      source_control_provider: 'ado',
      pull_request_number: prNumber,
      pull_request_title: prTitle,
      pull_request_url: prUrl,
      source_branch: branchName,
      target_branch: targetBranch,
      current_head_sha: headSha || 'unknown',
      task_link_see: `[See task](${cloudJobUrl})`,
      review_scope:
        'Review only the Azure DevOps pull request changes. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the diff with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
      suggested_diff_commands: [
        targetBranch
          ? `git fetch origin ${targetBranch} && git diff origin/${targetBranch}...HEAD`
          : 'git diff origin/HEAD...HEAD',
        headSha ? `git show --stat ${headSha}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  });
}

function adoPullRequestReview({
  cloudTask,
  cloudJobUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  cloudJobUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}) {
  const prompt = buildAdoPullRequestReviewPrompt({
    cloudTask,
    cloudJobUrl,
  });

  return standardTask({
    description: prompt,
    repo: cloudTask.payload.repo,
    taskSurface: 'ado',
    cloudJobUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: cloudTask.payload.linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });
}

export async function githubPrReview({
  cloudTask,
  gitHubToken,
  cloudJobUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  cloudTask: GithubPullRequestReviewOpenTask;
  gitHubToken: string;
  cloudJobUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  switch (resolveSourceControlProviderFromPayload(cloudTask.payload)) {
    case 'gitlab':
      return gitLabMergeRequestReview({
        cloudTask,
        cloudJobUrl,
        attribution,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });
    case 'gitea':
      return giteaPullRequestReview({
        cloudTask,
        cloudJobUrl,
        attribution,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });
    case 'ado':
      return adoPullRequestReview({
        cloudTask,
        cloudJobUrl,
        attribution,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });
    case 'github':
      break;
  }

  const {
    payload: {
      prNumber,
      repo: fullName,
      branchName,
      linkedWorkItems: payloadLinkedWorkItems,
      relayReviewResultsToTask: payloadRelayReviewResultsToTask,
      linkedTaskId: payloadLinkedTaskId,
      linkedTaskRelayLookupPending: payloadLinkedTaskRelayLookupPending,
    },
  } = cloudTask;

  const shouldApprovePr = false;
  const { relayReviewResultsToTask, linkedTaskId } =
    await resolveLinkedTaskReviewHandoff({
      repository: fullName,
      prNumber,
      branchName,
      reviewerSettings: null,
      payloadRelayReviewResultsToTask,
      payloadLinkedTaskId,
      payloadLinkedTaskRelayLookupPending,
    });

  const agentType = 'PR Reviewer';

  const params: GitHubCli.FetchParams = { gitHubToken, repo: fullName };
  const prParams: GitHubCli.FetchPrParams = { ...params, prNumber };

  const pr = await GitHubCli.fetchPr(prParams);

  const issueNumber = pr.closingIssuesReferences[0]?.number;

  const issue = issueNumber
    ? await GitHubCli.fetchIssue({ ...params, issueNumber })
    : null;
  const linkedWorkItems = mergeLinkedWorkItems(
    payloadLinkedWorkItems,
    getGitHubLinkedWorkItemsFromClosingIssues({
      closingIssuesReferences: pr.closingIssuesReferences,
      fallbackRepository: fullName,
    }),
  );

  const { diff, changedFiles } = await GitHubCli.fetchDiff(prParams);
  const reviewComments = await GitHubCli.fetchReviewComments(prParams);
  const issueComments = await GitHubCli.fetchIssueComments(prParams);

  /**
   * Top-level Review Comment
   */

  const [owner, repo] = fullName.split('/');

  const existingReviewSummaryComment =
    findReusableReviewSummaryComment(issueComments);
  const followLink = buildGithubCommentActionLink({
    href: cloudJobUrl,
    label: 'Follow',
  });
  const reviewStatus = GitHubSchemas.isRoomoteGitHubLogin(pr.author.login)
    ? 'Self-reviewing the PR with fresh eyes now.'
    : 'Reviewing the PR now.';
  const inProgressStatus = `${reviewStatus} ${followLink}`;
  const summaryMarker = `<!-- roomote-review-summary sha=${pr.headRefOid} mode=initial -->`;
  const body = buildReviewSummaryBody({
    summaryMarker,
    statusContent: inProgressStatus,
  });
  let topLevelCommentId = existingReviewSummaryComment?.id;

  if (!topLevelCommentId) {
    try {
      const reviewComment = await createIssueComment(gitHubToken, {
        owner: owner!,
        repo: repo!,
        issue_number: prNumber,
        body,
      });

      topLevelCommentId = reviewComment.data.id;
    } catch (error) {
      console.error(
        `[reviewPr] failed to create review comment: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error;
    }
  } else if (existingReviewSummaryComment) {
    try {
      const updatedBody = buildInProgressReviewSummaryBody({
        existingBody: existingReviewSummaryComment.body,
        inProgressStatus,
        summaryMarker,
      });

      await updateIssueComment(gitHubToken, {
        owner: owner!,
        repo: repo!,
        comment_id: topLevelCommentId,
        body: updatedBody,
      });
    } catch (error) {
      console.error(
        `[reviewPr] failed to update reusable review comment: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error;
    }
  }

  const delimiter = getSkillCommandDelimiter(cloudTask.harness);
  const activeSkillPath = shouldApprovePr
    ? 'review-github-pr-with-approval'
    : 'review-github-pr';
  const command = `${delimiter}review-code`;

  const prompt = buildStructuredTaskRequest({
    command,
    activeAppendixPath: activeSkillPath,
    taskContext: {
      repository: fullName,
      pull_request_number: prNumber,
      agent_type: agentType,
      pull_request_base_sha: pr.baseRefOid,
      current_head_sha: pr.headRefOid,
      top_level_comment_id: topLevelCommentId,
      comment_header_starting: '',
      comment_header_completed: '',
      task_link_follow: followLink,
      task_link_see: `[See task](${cloudJobUrl})`,
      linked_implementation_task_handoff_enabled: relayReviewResultsToTask,
      linked_implementation_task_id: linkedTaskId,
      pull_request_details: getPrDetails({ fullName, pr }),
      changed_files: formatChangedFiles(changedFiles, 200),
      linked_issue: getIssueDetails(fullName, issue),
      pull_request_diff: getDiff({
        prNumber,
        repo: fullName,
        diff,
        lineLimit: 5_000,
        charLimit: 100_000,
      }),
      existing_review_comments: getReviewComments(reviewComments),
      issue_comments: getIssueComments(issueComments),
    },
  });

  const standardTaskResult = standardTask({
    description: prompt,
    repo: fullName,
    taskSurface: 'github',
    cloudJobUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });

  return {
    prompt: standardTaskResult.prompt,
    harnessInstructions: standardTaskResult.harnessInstructions,
    artifacts: { githubPrReviewCommentId: topLevelCommentId },
  };
}
