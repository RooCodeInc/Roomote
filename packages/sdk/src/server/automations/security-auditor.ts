import type { RepositoryCoverage } from '@roomote/cloud-agents/server';
import {
  buildDestinationPromptContext,
  type ResolvedAutomationDestination,
} from './destination';
import {
  buildMergedPullRequestTaskContext,
  createMergedPullRequestAuditJob,
  type MergedPullRequest,
  type MergedPullRequestAuditScanMode,
} from './merged-pr-audit-runner';

function buildSecurityAuditorPrompt(params: {
  channelId: string;
  destination: ResolvedAutomationDestination;
  hasMorePullRequests: boolean;
  mergedPullRequests: MergedPullRequest[];
  manualTrigger: boolean;
  repositoryCoverage: RepositoryCoverage[];
  scanMode: MergedPullRequestAuditScanMode;
  recentThreadFeedback?: string | null;
}): string {
  const promptContext = buildDestinationPromptContext(params.destination);
  const followUpInstructions = `If you find actionable, repository-targeted follow-up work that is genuinely net-new or materially strengthens a previously surfaced issue, submit up to five \`act\` work items with \`submit_automation_work_items\`. Do not submit suggestion work items; they are rejected. Before submitting any work item, classify it as net-new, same finding with decision-changing new evidence, or already-known/no new action, and do not submit the third case. Treat a newly identified introducing PR, a materially broader exploit path, evidence that a supposed fix did not land, or proof that the earlier follow-up is stale or mis-scoped as decision-changing. When in doubt, suppress the duplicate action item. Each submitted work item must target exactly one repository from \`repository_scope\`, use \`actionKind\` "code_change_pr", use \`disposition\` "act", set \`targetRepositoryFullName\`, and include an \`executionPrompt\` that starts with \`$implement-changes\`. Only target repositories that appear in \`repository_environments\`, copy the matching \`targetEnvironmentId\`, and do not fall back to bare-repo launches. In that execution prompt, tell the follow-up task what to verify, what to change, and what PR outcome to aim for if the finding holds. Use category "security" by default and include investigationContext with "$security-auditor", the PR URL or number, the files or code paths reviewed, the specific concern, why it matters, and the verification or fix the follow-up task should perform. If \`submit_automation_work_items\` succeeds for one or more work items, do not call \`${promptContext.postToolName}\` and do not post a separate ${promptContext.surfaceLabel} summary; each execution task reports its own result to ${promptContext.surfaceLabel} when it finishes. End the task response with a terse internal note that work items were submitted.`;

  return `$security-auditor

${buildMergedPullRequestTaskContext(params)}

Review the merged pull requests listed above from a security standpoint and for adherence to secure coding best practices.

Use the installed \`security-review\` and \`security-best-practices\` skills while working through this audit. For each listed PR, inspect the actual diff before suggesting follow-up work — use local git history (the PR's merge commit) or, on GitHub repositories, \`gh\`; do not rely only on titles or summaries. Do not update scheduler checkpoints or audit PRs outside the provided manifest; follow-up scheduler runs will handle any remaining PRs when has_more_prs is true.

${followUpInstructions}

Only submit HIGH-confidence findings or materially missing secure-by-default corrections. If there are no actionable findings after reviewing the listed PRs, do not call submit_automation_work_items and do not ${promptContext.postToolName}. End the task response with a terse internal note that no security follow-up was needed.

${params.recentThreadFeedback?.trim() ? `Recent feedback from earlier Security Auditor threads:\n${params.recentThreadFeedback.trim()}\n` : ''}`;
}

export const securityAuditorJob = createMergedPullRequestAuditJob({
  automationKey: 'security_auditor',
  buildPrompt: buildSecurityAuditorPrompt,
});
