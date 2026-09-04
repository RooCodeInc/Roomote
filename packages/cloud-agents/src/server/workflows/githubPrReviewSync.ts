import {
  type GithubPullRequestReviewSyncTask,
  getSkillCommandDelimiter,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import { Cli as GitHubCli } from '@roomote/github';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

import {
  appendAdditionalTeamInstructions,
  buildGithubCommentActionLink,
  buildStructuredTaskRequest,
  getPrDetails,
  getCommits,
  getIssueDetails,
  getDiff,
  getMarkdownChecklist,
  getReviewComments,
  getIssueComments,
  getPrSha,
  getPrReviewCommentId,
  formatChangedFiles,
  resolveScopedSyncReviewDelta,
} from './utils';
import {
  getGitHubLinkedWorkItemsFromClosingIssues,
  mergeLinkedWorkItems,
} from './pr-linked-work-items';
import { resolveLinkedTaskReviewHandoff } from './resolve-linked-task-review-handoff';
import { standardTask } from './standardTask';

function buildGitLabMergeRequestSyncReviewPrompt({
  taskSpec,
  taskRunUrl,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
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
  } = taskSpec;
  const delimiter = getSkillCommandDelimiter(taskSpec.harness);

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
      task_link_see: `[See task](${taskRunUrl})`,
      review_scope:
        'Review the new GitLab merge request changes since the prior review. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the changed range with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
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

function gitLabMergeRequestSyncReview({
  taskSpec,
  taskRunUrl,
  additionalInstructions,
  attribution,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
  additionalInstructions?: string | null;
  attribution?: ResolvedTaskCommitAuthor;
}) {
  const prompt = buildGitLabMergeRequestSyncReviewPrompt({
    taskSpec,
    taskRunUrl,
  });

  return standardTask({
    description: appendAdditionalTeamInstructions(
      prompt,
      additionalInstructions,
    ),
    repo: taskSpec.payload.repo,
    taskSurface: 'gitlab',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
  });
}

function buildGiteaPullRequestSyncReviewPrompt({
  taskSpec,
  taskRunUrl,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
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
  } = taskSpec;
  const delimiter = getSkillCommandDelimiter(taskSpec.harness);

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
      task_link_see: `[See task](${taskRunUrl})`,
      review_scope:
        'Review the new Gitea pull request changes since the prior review. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the changed range with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
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

function giteaPullRequestSyncReview({
  taskSpec,
  taskRunUrl,
  additionalInstructions,
  attribution,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
  additionalInstructions?: string | null;
  attribution?: ResolvedTaskCommitAuthor;
}) {
  const prompt = buildGiteaPullRequestSyncReviewPrompt({
    taskSpec,
    taskRunUrl,
  });

  return standardTask({
    description: appendAdditionalTeamInstructions(
      prompt,
      additionalInstructions,
    ),
    repo: taskSpec.payload.repo,
    taskSurface: 'gitea',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
  });
}

function buildBitbucketPullRequestSyncReviewPrompt({
  taskSpec,
  taskRunUrl,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
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
  } = taskSpec;
  const delimiter = getSkillCommandDelimiter(taskSpec.harness);

  return buildStructuredTaskRequest({
    command: `${delimiter}review-code`,
    taskContext: {
      repository: fullName,
      source_control_provider: 'bitbucket',
      pull_request_number: prNumber,
      pull_request_title: prTitle,
      pull_request_url: prUrl,
      source_branch: branchName,
      target_branch: targetBranch,
      current_head_sha: headSha || 'unknown',
      task_link_see: `[See task](${taskRunUrl})`,
      review_scope:
        'Review the new Bitbucket pull request changes since the prior review. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the changed range with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
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

function bitbucketPullRequestSyncReview({
  taskSpec,
  taskRunUrl,
  additionalInstructions,
  attribution,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
  additionalInstructions?: string | null;
  attribution?: ResolvedTaskCommitAuthor;
}) {
  const prompt = buildBitbucketPullRequestSyncReviewPrompt({
    taskSpec,
    taskRunUrl,
  });

  return standardTask({
    description: appendAdditionalTeamInstructions(
      prompt,
      additionalInstructions,
    ),
    repo: taskSpec.payload.repo,
    taskSurface: 'bitbucket',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
  });
}

function buildAdoPullRequestSyncReviewPrompt({
  taskSpec,
  taskRunUrl,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
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
  } = taskSpec;
  const delimiter = getSkillCommandDelimiter(taskSpec.harness);

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
      task_link_see: `[See task](${taskRunUrl})`,
      review_scope:
        'Review the new Azure DevOps pull request changes since the prior review. Use the prepared local repository, source branch, target branch, and commit SHA to inspect the changed range with git commands. Do not use GitHub-only CLI commands such as `gh pr`.',
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

function adoPullRequestSyncReview({
  taskSpec,
  taskRunUrl,
  additionalInstructions,
  attribution,
}: {
  taskSpec: GithubPullRequestReviewSyncTask;
  taskRunUrl: string;
  additionalInstructions?: string | null;
  attribution?: ResolvedTaskCommitAuthor;
}) {
  const prompt = buildAdoPullRequestSyncReviewPrompt({
    taskSpec,
    taskRunUrl,
  });

  return standardTask({
    description: appendAdditionalTeamInstructions(
      prompt,
      additionalInstructions,
    ),
    repo: taskSpec.payload.repo,
    taskSurface: 'ado',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
  });
}

export async function githubPrReviewSync({
  runId,
  taskSpec,
  gitHubToken,
  taskRunUrl,
  additionalInstructions,
  attribution,
  therapistModeEnabled,
}: {
  runId?: number;
  taskSpec: GithubPullRequestReviewSyncTask;
  gitHubToken: string;
  taskRunUrl: string;
  additionalInstructions?: string | null;
  attribution?: ResolvedTaskCommitAuthor;
  therapistModeEnabled?: boolean;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  switch (resolveSourceControlProviderFromPayload(taskSpec.payload)) {
    case 'gitlab':
      return gitLabMergeRequestSyncReview({
        taskSpec,
        taskRunUrl,
        additionalInstructions,
        attribution,
      });
    case 'gitea':
      return giteaPullRequestSyncReview({
        taskSpec,
        taskRunUrl,
        additionalInstructions,
        attribution,
      });
    case 'bitbucket':
      return bitbucketPullRequestSyncReview({
        taskSpec,
        taskRunUrl,
        additionalInstructions,
        attribution,
      });
    case 'ado':
      return adoPullRequestSyncReview({
        taskSpec,
        taskRunUrl,
        additionalInstructions,
        attribution,
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
  } = taskSpec;

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
  const currentHeadSha = pr.headRefOid;

  const sha = await getPrSha({
    currentRunId: runId,
    repo: fullName,
    prNumber,
  });

  if (!sha) {
    throw new Error('Previous review SHA is required');
  }

  const range: [string, string] = [sha, currentHeadSha];
  const sameHeadAsLastReview = sha === currentHeadSha;

  // The since-last-review range (compare `sha...currentHeadSha`) uses
  // three-dot semantics, so after the branch is rebased onto its base it
  // also contains every commit pulled in from the base branch — code the PR
  // does not touch. Scope the range to the PR's authoritative Files Changed
  // (base...head, what GitHub shows) so a rebase can no longer import
  // findings for unrelated files. The remaining rebase case — the head moved
  // but the PR's own already-reviewed files reappear in the three-dot range —
  // is settled by the skill's local two-dot delta, which this layer cannot
  // compute.
  const pullRequestDiffResult = sameHeadAsLastReview
    ? { diff: undefined, changedFiles: [] as string[] }
    : await GitHubCli.fetchDiff(prParams);

  const rangeResult = sameHeadAsLastReview
    ? { diff: undefined, changedFiles: [] as string[] }
    : await GitHubCli.fetchDiffInRange({
        ...params,
        range,
      });

  const {
    pullRequestFilesAvailable,
    changedFiles,
    diff,
    hasReviewableChanges,
  } = resolveScopedSyncReviewDelta({
    sameHeadAsLastReview,
    pullRequestDiff: pullRequestDiffResult,
    rangeDiff: rangeResult,
  });
  const pullRequestChangedFiles = pullRequestDiffResult.changedFiles;

  const commits = hasReviewableChanges
    ? await GitHubCli.fetchCommitsInRange({ ...prParams, sha })
    : [];
  const reviewComments = await GitHubCli.fetchReviewComments(prParams);
  const issueComments = await GitHubCli.fetchIssueComments(prParams);

  /**
   * Top-level PR review comment
   */

  const prReviewerCommentId = await getPrReviewCommentId({
    repo: fullName,
    prNumber,
  });

  if (!prReviewerCommentId) {
    throw new Error('Top-level comment ID is required');
  }

  const prReviewerComment = await GitHubCli.fetchIssueComment({
    ...params,
    commentId: prReviewerCommentId,
  });

  if (!prReviewerComment) {
    throw new Error('Top-level PR reviewer comment not found');
  }

  const delimiter = getSkillCommandDelimiter(taskSpec.harness);
  const followLink = buildGithubCommentActionLink({
    href: taskRunUrl,
    label: 'Follow',
  });
  const activeSkillPath = shouldApprovePr
    ? 'sync-github-pr-review-with-approval'
    : 'sync-github-pr-review';
  const command = `${delimiter}review-code`;
  const priorSummaryChecklist = getMarkdownChecklist(prReviewerComment.body);

  const prompt = buildStructuredTaskRequest({
    command,
    activeAppendixPath: activeSkillPath,
    taskContext: {
      repository: fullName,
      pull_request_number: prNumber,
      workflow: 'pr_review',
      pull_request_base_sha: pr.baseRefOid,
      last_review_sha: sha,
      current_head_sha: currentHeadSha,
      top_level_comment_id: prReviewerCommentId,
      comment_header_starting: '',
      comment_header_completed: '',
      task_link_follow: followLink,
      task_link_see: `[See task](${taskRunUrl})`,
      linked_implementation_task_handoff_enabled: relayReviewResultsToTask,
      linked_implementation_task_id: linkedTaskId,
      pull_request_details: getPrDetails({ fullName, pr }),
      top_level_review_comment: prReviewerComment.body,
      prior_summary_checklist: priorSummaryChecklist,
      pull_request_changed_files:
        sameHeadAsLastReview || !pullRequestFilesAvailable
          ? undefined
          : formatChangedFiles(pullRequestChangedFiles, 200),
      changed_files_since_last_review: hasReviewableChanges
        ? formatChangedFiles(changedFiles, 200)
        : undefined,
      commits_since_last_review: hasReviewableChanges
        ? getCommits(commits)
        : undefined,
      linked_issue: getIssueDetails(fullName, issue),
      // `diff` is the PR's own base...head hunks for the files that changed
      // since the last review (never the three-dot range content), so it is
      // rendered as the pull-request diff rather than a compare range.
      diff_in_range: hasReviewableChanges
        ? getDiff({
            prNumber,
            repo: fullName,
            diff,
            lineLimit: 5_000,
            charLimit: 100_000,
          })
        : undefined,
      existing_review_comments: getReviewComments(reviewComments),
      issue_comments: getIssueComments(issueComments),
    },
  });

  return standardTask({
    description: appendAdditionalTeamInstructions(
      prompt,
      additionalInstructions,
    ),
    repo: fullName,
    taskSurface: 'github',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems,
    therapistModeEnabled,
  });
}
