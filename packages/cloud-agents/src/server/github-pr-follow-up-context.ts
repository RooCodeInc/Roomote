import { buildGitHubMessageInstructions } from './github-message-instructions';
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
    '- `explain-repo-code` for explanation-only requests about the current PR',
    '',
    buildGitHubRequestedFollowUpBlock(commentBody),
    '',
    buildGitHubTaskContextBlock(taskContext),
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

${buildGitHubMessageInstructions()}`;
}
