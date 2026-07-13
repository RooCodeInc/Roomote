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

function buildCodeQualityAuditorPrompt(params: {
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
  const followUpInstructions = `If you find actionable, repository-targeted follow-up work, submit up to five \`act\` work items with \`submit_automation_work_items\`. Do not submit suggestion work items; they are rejected. Each submitted work item must target exactly one repository from \`repository_scope\`, use \`actionKind\` "code_change_pr", use \`disposition\` "act", set \`targetRepositoryFullName\`, and include an \`executionPrompt\` that starts with \`$implement-changes\`. Only target repositories that appear in \`repository_environments\`, copy the matching \`targetEnvironmentId\`, and do not fall back to bare-repo launches. In that execution prompt, start with a conversational investigation sentence naming the specific maintainability risk or requested check in user-facing terms, such as what drifted, got duplicated, or became a second source of truth, instead of jumping straight into the refactor summary. Phrase it like a teammate describing what they looked through and what they noticed. Assume the ${promptContext.surfaceLabel} reader does not have any other context about the requested investigation, so that opener should briefly restate both what area or workflow was being checked and that this was a code-quality investigation before it says what was found. After that opener, tell the follow-up task what to verify, what to simplify or refactor, and what PR outcome to aim for if the concern holds. Use category "improvement" by default, include investigationContext with "$code-quality-auditor", the PR URL or number, the files or code paths reviewed, the specific code quality concern, why it matters, and the verification or refactor work the follow-up task should perform. If \`submit_automation_work_items\` succeeds for one or more work items, do not call \`${promptContext.postToolName}\` and do not post a separate ${promptContext.surfaceLabel} summary; each execution task reports its own result to ${promptContext.surfaceLabel} when it finishes. End the task response with a terse internal note that work items were submitted.`;

  return `$code-quality-auditor

${buildMergedPullRequestTaskContext(params)}

Review the merged pull requests listed above from a code quality standpoint.

Use an unusually strict maintainability bar. Be ambitious about structural simplification and look for "code judo" moves that delete layers, helpers, modes, or conditionals rather than merely polishing them. Focus on maintainability, clarity, naming, cohesion, coupling, duplication, abstraction quality, API ergonomics, test quality, lifecycle cleanup, and architectural drift. Prioritize quality issues over correctness bugs. For each listed PR, use \`gh\` or local git history to inspect the actual diff before suggesting follow-up work; do not rely only on titles or summaries. Do not update scheduler checkpoints or audit PRs outside the provided manifest; follow-up scheduler runs will handle any remaining PRs when has_more_prs is true.

Flag strong code-quality smells aggressively: a file growing from under 1000 lines to over 1000 lines without a compelling reason, ad-hoc branching or one-off flags bolted into busy flows, feature logic leaking into shared layers, wrappers that add indirection without clarity, duplicated bespoke helpers when a canonical utility already exists, cast-heavy or optionality-heavy contracts that hide the real invariant, and sequential or non-atomic orchestration when a simpler structure is obvious.

Prefer direct, boring, maintainable code over magical or overly generic mechanisms. Push logic toward the canonical owning layer, reuse existing helpers, and treat missed opportunities for dramatic simplification as more important than cosmetic cleanup.

${followUpInstructions}

Only submit HIGH-confidence maintainability or design issues that are worth a follow-up task. Prioritize structural regressions, spaghetti growth, boundary or abstraction problems, file-size explosions, and missed simplification opportunities over minor legibility notes. Skip style-only nits, personal preference debates, and correctness-only findings that another automation should own. If there are no actionable findings after reviewing the listed PRs, do not call submit_automation_work_items and do not ${promptContext.postToolName}. End the task response with a terse internal note that no code quality follow-up was needed.

${params.recentThreadFeedback?.trim() ? `Recent feedback from earlier Code Quality Auditor threads:\n${params.recentThreadFeedback.trim()}\n` : ''}`;
}

export const codeQualityAuditorJob = createMergedPullRequestAuditJob({
  automationKey: 'code_quality_auditor',
  buildPrompt: buildCodeQualityAuditorPrompt,
});
