import { buildGitHubMessageInstructions } from './github-message-instructions';
import { buildUntrustedContentPolicy } from './untrusted-content';
import { escapeTaskContextText } from './workflows/utils';

export type GitHubTaskContextValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type GitHubTaskContext = Record<string, GitHubTaskContextValue>;

export function buildGitHubTaskContextBlock(
  taskContext: GitHubTaskContext,
): string {
  const lines = ['<task_context>'];

  for (const [tag, value] of Object.entries(taskContext)) {
    if (value === undefined || value === null) {
      continue;
    }

    lines.push(`    <${tag}>${escapeTaskContextText(String(value))}</${tag}>`);
  }

  lines.push('</task_context>');

  return lines.join('\n');
}

function buildGitHubRequestedFollowUpBlock(commentBody: string): string {
  return [
    '<requested-follow-up>',
    escapeTaskContextText(commentBody),
    '</requested-follow-up>',
  ].join('\n');
}

export function buildGitHubMentionFollowUpRequest({
  commentBody,
  taskContext,
}: {
  commentBody: string;
  taskContext: GitHubTaskContext;
}): string {
  return [
    'A GitHub pull request comment mentioned Roomote and this run is the new dedicated follow-up task for that PR.',
    'Use the current PR context below and keep the work scoped to this repository and pull request.',
    'If the triggering comment is only gratitude or other non-actionable conversation, reply briefly on GitHub if useful and conclude with a no-op result instead of inventing follow-up work.',
    'Use the standard workflow initial routing rules to choose the correct starting skill for the current request:',
    '- `implement-changes` for actionable PR follow-up work, including code, docs, tests, config, prompt, or routing changes',
    '- `plan-repo-implementation` for planning or scoping requests that should stay non-mutating',
    '- `explore-and-act` for investigation, verification, or requested connected-system actions that do not require repository or workspace changes',
    '- `explain-repo-code` for explanation-only requests about the current PR',
    '',
    buildGitHubRequestedFollowUpBlock(commentBody),
    '',
    buildGitHubTaskContextBlock(taskContext),
    '',
    buildUntrustedContentPolicy(),
    '',
    buildGitHubMessageInstructions(),
  ].join('\n');
}

export function buildGitHubExistingTaskFollowUpMessage({
  commentBody,
  routingReason,
  taskContext,
}: {
  commentBody: string;
  routingReason: string;
  taskContext: GitHubTaskContext;
}): string {
  const escapedRoutingReason = escapeTaskContextText(routingReason);

  return `<github-pr-follow-up>
This GitHub PR mention was routed into the existing Roomote task for the same pull request so follow-up work stays on one PR execution thread. Do not start or assume a second Roomote executor for this follow-up.

${buildGitHubRequestedFollowUpBlock(commentBody)}

GitHub routing path: follow_up
Routing reason: ${escapedRoutingReason}

Execution rules:
- Continue the follow-up on the current PR branch and existing pull request.
- Treat the PR context below as the GitHub discussion context the commenter was looking at.
- Do not open a second PR for this request unless the original PR is already closed or its branch no longer exists.
- If this inserted mention is only gratitude or other non-actionable conversation, do not pivot or invent new work from it. Reply briefly on GitHub if useful and otherwise treat this insertion as a no-op.

${buildGitHubTaskContextBlock(taskContext)}
</github-pr-follow-up>

${buildUntrustedContentPolicy()}

${buildGitHubMessageInstructions()}`;
}

export function buildGitHubPrSynchronizeFollowUpMessage({
  repository,
  prNumber,
  previousHeadSha,
  eventHeadSha,
}: {
  repository: string;
  prNumber: number;
  previousHeadSha?: string | null;
  eventHeadSha: string;
}): string {
  const requestedFollowUp =
    'New commits were pushed while this pull request review was active. Re-review the live pull request head before finalizing the current review.';

  return `<github-pr-follow-up>
GitHub reported new commits while this Roomote PR review task was already active. Keep this work in the current task and OpenCode session; do not create another task, executor, sandbox, branch, or pull request.

${buildGitHubRequestedFollowUpBlock(requestedFollowUp)}

Execution rules:
- Treat this as an update to the current review, not a separate user request.
- Fetch the live pull request head again before finalizing; the live GitHub head is authoritative if it differs from the webhook SHA.
- Review every newly introduced change that was not covered by the earlier review pass, and reconcile the existing summary and findings against the final live head.
- Do not conclude the review until the newly pushed changes have been included.

${buildGitHubTaskContextBlock({
  repository,
  pull_request_number: prNumber,
  previous_review_head_sha: previousHeadSha,
  synchronize_event_head_sha: eventHeadSha,
})}
</github-pr-follow-up>

${buildUntrustedContentPolicy()}

${buildGitHubMessageInstructions()}`;
}
