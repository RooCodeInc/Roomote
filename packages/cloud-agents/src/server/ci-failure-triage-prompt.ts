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
 * Builds the one-task CI failure prompt: investigate the red run in this
 * environment-backed workspace and fix it in the same task when actionable.
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
   * message; this same task must resolve that thread.
   */
  hasAnnouncementThread?: boolean;
  recentThreadFeedback?: string | null;
}): string {
  const repositoryScope =
    repositoryFullNames.length > 0
      ? repositoryFullNames.map((fullName) => `- ${fullName}`).join('\n')
      : 'No repositories from configured Roomote environments are eligible.';
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
    : `This task owns exactly one repository from repository_scope. Use \`gh run list\` against that repository's default branch to find workflow runs that failed since the scan window start, pick the highest-blast-radius persistent failure (or conclude nothing needs action), and \`gh run view\` / \`gh run view --log-failed\` to inspect it.`;

  const slackInstructions = hasAnnouncementThread
    ? `An "investigating" announcement has already been posted in the Slack thread for this run. Every terminal outcome must resolve that thread with send_chat_reply purpose "closeout":
- If the failure needs no action (already fixed by a newer run, a one-off flake, or covered by an open Roomote PR), say so with evidence.
- If you open a PR, report the PR and what changed (plain language).
- If you hit a setup/auth/blocker, report it in the thread, free of raw GitHub CLI commands, \`gh api\` invocations, or command transcripts.
Do not post progress updates, and never leave the announcement thread unresolved.`
    : `Stay silent on Slack while work is in flight. Create Slack output only if you need input, hit a blocker, or finish with a meaningful result (including a PR or an evidence-backed no-op when humans would otherwise wonder what happened on a manual Run now). Prefer the configured channel (\`slack_channel_id\`) when you must report. Keep Slack plain-language and never paste raw GitHub CLI commands, \`gh api\` invocations, or command transcripts.`;

  return `$ci-failure-triage

<task_context>
  <source>background-automation</source>
  <run_mode>investigate_and_fix</run_mode>
  <trigger>${trigger}</trigger>
  <scan_window>failed default-branch workflow runs since ${scanWindowStart.toISOString()}</scan_window>${triggeringRunSection}
  <slack_channel_id>${channelId}</slack_channel_id>
  <repository_scope>
${repositoryScope}
  </repository_scope>
</task_context>

You are the single Roomote task for this CI failure. This environment already matches the target repository. Investigate, then fix in this same task when the failure is real and fixable. Do **not** call \`submit_automation_work_items\`. Do **not** launch another task. Do not re-run GitHub Actions workflows.

${openingInstruction}

Classify the failure:
- Skip when a newer run of the same workflow on the same branch already passes (already fixed).
- Skip one-off infrastructure or runner flakes that did not recur.
- Skip when an open Roomote PR already addresses the same failure.
- Treat as actionable when it is the most recent run of its workflow on the default branch and the logs point at a concrete job, step, test, or command.

If the failure is not actionable, close out with evidence and stop without code changes.

If it is actionable, continue in this same task as an implement-changes style fix:
1. Reproduce the failure by running the failing job's commands from the workflow definition inside this environment.
2. Identify the introducing commit or root cause when history makes that cheap.
3. Implement the smallest fix that makes the failing job pass.
4. Re-run those verification commands.
5. Open a draft PR through the normal delivery path.
6. If the failure does not reproduce, report a no-op with evidence (flaky test or transient infrastructure) and do not change code.

${slackInstructions}

${repositoryEnvironmentSection}
${recentThreadFeedback?.trim() ? `Recent feedback from earlier CI failure triage threads:\n${recentThreadFeedback.trim()}\n` : ''}`;
}
