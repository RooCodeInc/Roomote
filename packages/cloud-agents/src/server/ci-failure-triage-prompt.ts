import {
  formatRepositoryEnvironmentLines,
  type RepositoryCoverage,
} from './repository-environment-coverage';

export type CiFailureTriageTrigger = 'scheduled' | 'manual' | 'webhook';

export type CiFailureTriageTriggeringRun = {
  repositoryFullName: string;
  workflowName: string;
  runUrl: string;
  headBranch: string;
  headSha: string;
};

/**
 * Shared by the GitHub workflow_run webhook handler (primary, immediate
 * trigger) and the scheduled fallback sweep in apps/bullmq.
 */
export function buildCiFailureTriagePrompt({
  channelId,
  repositoryFullNames,
  repositoryCoverage,
  scanWindowStart,
  trigger,
  triggeringRun,
  hasAnnouncementThread,
  recentThreadFeedback,
}: {
  channelId: string;
  repositoryFullNames: string[];
  repositoryCoverage: RepositoryCoverage[];
  scanWindowStart: Date;
  trigger: CiFailureTriageTrigger;
  triggeringRun?: CiFailureTriageTriggeringRun | null;
  /**
   * True when the webhook handler already posted an "investigating" root
   * message; the scan and its execution tasks reply in that thread.
   */
  hasAnnouncementThread?: boolean;
  recentThreadFeedback?: string | null;
}): string {
  const repositoryScope =
    repositoryFullNames.length > 0
      ? repositoryFullNames.map((fullName) => `- ${fullName}`).join('\n')
      : 'No repositories from configured Roomote environments are eligible for action-taking follow-up tasks.';
  const repositoryEnvironmentScope =
    formatRepositoryEnvironmentLines(repositoryCoverage);
  const repositoryEnvironmentSection = repositoryEnvironmentScope
    ? `\nRepository environments:\n${repositoryEnvironmentScope}\n`
    : '';
  const triggeringRunSection = triggeringRun
    ? `\n  <triggering_run>
    <repository>${triggeringRun.repositoryFullName}</repository>
    <workflow>${triggeringRun.workflowName}</workflow>
    <run_url>${triggeringRun.runUrl}</run_url>
    <head_branch>${triggeringRun.headBranch}</head_branch>
    <head_sha>${triggeringRun.headSha}</head_sha>
  </triggering_run>`
    : '';
  const openingInstruction = triggeringRun
    ? `A workflow run just failed on the default branch (see triggering_run). Start from that run with \`gh run view\` / \`gh run view --log-failed\`, then check the workflow's recent history on the same branch to judge whether the failure is persistent, a flake, or already fixed.`
    : `For each repository in repository_scope, use \`gh run list\` against the repository's default branch to find workflow runs that failed since the scan window start, and \`gh run view\` / \`gh run view --log-failed\` to inspect the failing jobs.`;
  const followUpInstructions = `${openingInstruction} Skip a failure when a newer run of the same workflow on the same branch already passes (it is fixed), when an open Roomote PR already addresses the same failure, or when the failure is a one-off infrastructure flake that did not recur. Treat a failure as actionable when it is the most recent run of its workflow on the default branch and the logs point at a concrete job, step, test, or command.

If you find actionable failures, submit up to 3 \`act\` automation work items with \`submit_automation_work_items\`. Do not submit suggestion work items; they are rejected. Submit at most one work item for each \`targetEnvironmentId\`, and group failing runs that share one root cause (same introducing commit, same failing job or test) into a single work item instead of one item per run.

Each submitted act item must:
- target exactly one repository from repository_scope
- copy the matching \`targetEnvironmentId\` from the "Repository environments" list
- include \`executionPrompt\` that starts with \`$implement-changes\` and tells the execution task to reproduce the failure first by running the failing job's commands from the workflow definition inside the environment, identify the introducing commit or root cause, implement the smallest fix that makes the failing job pass, re-run those commands to verify the fix, and open a PR; if the failure does not reproduce, it should report a no-op with the evidence (for example a flaky test or transient infrastructure) instead of changing code
- include investigationContext with "$ci-failure-triage", the workflow name, the failing job and step, the run URLs, the head SHA, the failure excerpt from the logs, whether the failure repeats across runs, the suspected introducing commit when identifiable, and the exact GitHub CLI commands used during triage
- set a stable \`fingerprint\` built from the repository, workflow name, and failure signature (failing job plus the failing test or error), so repeated triage of the same broken state deduplicates instead of launching duplicate tasks

Use category "bug" for product or test regressions and "chore" for CI-configuration or tooling failures.

${
  hasAnnouncementThread
    ? `An "investigating" announcement has already been posted in the Slack thread for this run, so every outcome must resolve that thread:
- If \`submit_automation_work_items\` succeeds and launches at least one execution task, do not post anything; the execution task reports its result in this thread when it finishes.
- If everything you would submit deduplicates against active work items (the tool result shows duplicates and nothing launched), reply once in the thread with send_chat_reply purpose "closeout" saying an existing Roomote investigation already covers this failure.
- If the failure needs no action (already fixed by a newer run, a one-off flake, or covered by an open Roomote PR), reply once in the thread with send_chat_reply purpose "closeout" giving that conclusion and the evidence (for example the newer passing run).
- For GitHub setup/auth blockers, reply in the thread instead of posting a new channel message, keeping that reply plain-language and free of raw GitHub CLI commands, \`gh api\` invocations, or command transcripts; the exact commands belong only in work item \`investigationContext\`.
Do not post progress updates, and never leave the announcement thread unresolved.`
    : `If \`submit_automation_work_items\` succeeds for one or more act items, do not call \`post_to_slack_channel\` and do not post a launch announcement. Each execution task starts silently and creates Slack output only later if it needs input, hits a blocker, or finishes with a result. End the task response with a terse internal note that action items were submitted.

If there are no failing default-branch runs in the window, every failure is already fixed or deduplicated, or there are no eligible configured-environment repositories, do not post to Slack; end with a terse internal note. Post a concise report to the configured Slack channel with \`post_to_slack_channel\` only for GitHub setup/auth blockers (for example missing Actions access), so configuration failures do not disappear silently. Keep any such report plain-language and do not paste raw GitHub CLI commands, \`gh api\` invocations, or command transcripts into Slack; the exact commands belong only in work item \`investigationContext\`.`
}`;

  return `$ci-failure-triage

<task_context>
  <source>background-automation</source>
  <run_mode>read_only</run_mode>
  <trigger>${trigger}</trigger>
  <scan_window>failed default-branch workflow runs since ${scanWindowStart.toISOString()}</scan_window>${triggeringRunSection}
  <slack_channel_id>${channelId}</slack_channel_id>
  <repository_scope>
${repositoryScope}
  </repository_scope>
</task_context>

Run CI failure triage with the GitHub access already available in the task environment. Keep this run read-only: do not re-run workflows, push commits, or mutate GitHub state.

${followUpInstructions}

${repositoryEnvironmentSection}

${recentThreadFeedback?.trim() ? `Recent feedback from earlier CI failure triage threads:\n${recentThreadFeedback.trim()}\n` : ''}`;
}
