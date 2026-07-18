import {
  buildRepositoryCoverage,
  formatRepositoryEnvironmentLines,
  getEnvironmentBackedCoverage,
  type RepositoryCoverage,
} from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES } from '@roomote/types';

import { loadAutomationThreadFeedbackContext } from './automation-thread-feedback';
import {
  buildDestinationPromptContext,
  type ResolvedAutomationDestination,
} from './destination';
import {
  getActiveGitHubRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
import { createScheduledTriageJob } from './scheduled-triage-runner';

function buildIssueFixerPrompt({
  channelId,
  destination,
  repositoryFullNames,
  repositoryCoverage,
  manualTrigger,
  recentThreadFeedback,
}: {
  channelId: string;
  destination: ResolvedAutomationDestination;
  repositoryFullNames: string[];
  repositoryCoverage: RepositoryCoverage[];
  manualTrigger: boolean;
  recentThreadFeedback?: string | null;
}): string {
  const promptContext = buildDestinationPromptContext(destination);
  const repositoryScope =
    repositoryFullNames.length > 0
      ? repositoryFullNames.map((fullName) => `- ${fullName}`).join('\n')
      : 'No repositories from configured Roomote environments are eligible for action-taking follow-up tasks.';
  const repositoryEnvironmentScope =
    formatRepositoryEnvironmentLines(repositoryCoverage);
  const repositoryEnvironmentSection = repositoryEnvironmentScope
    ? `\nRepository environments:\n${repositoryEnvironmentScope}\n`
    : '';
  const followUpInstructions = `If you find actionable candidates, submit up to 3 \`act\` automation work items with \`submit_automation_work_items\`. Do not submit any suggestion work items; they are rejected. Submit at most one work item for each \`targetEnvironmentId\`. Only consider repositories that appear in the "Repository environments" list below. Do not fall back to bare-repo launches. Pick the highest-priority cohesive open GitHub issues across the eligible repositories. Prefer one issue per work item. Start with the narrowest high-quality fix that is likely to work; do not turn one issue into a broad rewrite unless the issue acceptance criteria require it.

Each submitted act item must:
- target exactly one repository from repository_scope
- copy the matching \`targetEnvironmentId\` from the "Repository environments" list
- include \`executionPrompt\` that starts with \`$implement-changes\`
- include investigationContext with the full GitHub issue URL, issue number, title, labels, assignees when present, a short summary of requirements and acceptance criteria, relevant comment decisions, the exact GitHub CLI or API commands used during triage, linked PRs if any, and the validation the execution task must perform before opening a PR
- use category "bug" for defect fixes, "feature" or "improvement" when the issue clearly asks for new or improved behavior, and "chore" only for mechanical hygiene issues

If \`submit_automation_work_items\` succeeds for one or more act items, do not call \`${promptContext.postToolName}\` and do not post a launch announcement. Each execution task starts silently and creates ${promptContext.surfaceLabel} output only later if it needs input, hits a blocker, or finishes with a result. End the task response with a terse internal note that action items were submitted.

If there are no actionable issues, no eligible configured-environment candidates, or no configured environment coverage, do not post to ${promptContext.surfaceLabel}; end with a terse internal note. Treat repository-level gaps such as a repository returning zero open issues or falling outside configured environment coverage as non-blocking no-op findings for this run, not as GitHub setup/auth blockers worth a ${promptContext.surfaceLabel} post. A clean read-only run is not worth a channel message. Post a concise report to the configured ${promptContext.surfaceLabel} channel with \`${promptContext.postToolName}\` only for GitHub setup/auth blockers (for example missing issues read access), so configuration failures do not disappear silently. Keep any such report plain-language and manager-readable, and do not paste the raw GitHub CLI commands, \`gh api\` invocations, or command transcripts into ${promptContext.surfaceLabel}; the exact commands belong only in work item \`investigationContext\`.`;

  return `$issue-fixer

<task_context>
  <source>background-automation</source>
  <run_mode>read_only</run_mode>
  <trigger>${manualTrigger ? 'manual' : 'scheduled'}</trigger>
  <issue_scope>current_open_github_issues</issue_scope>
  <${promptContext.channelTag}>${channelId}</${promptContext.channelTag}>
  <repository_scope>
${repositoryScope}
  </repository_scope>
</task_context>

Run Issue Fixer triage with the GitHub access already available in the task environment. Keep this run read-only.

${followUpInstructions}

${repositoryEnvironmentSection}

${recentThreadFeedback?.trim() ? `Recent feedback from earlier Issue Fixer threads:\n${recentThreadFeedback.trim()}\n` : ''}`;
}

export const issueFixerJob = createScheduledTriageJob({
  automationKey: 'issue_fixer',
  async buildScanTask({ channelId, destination, manualTrigger }) {
    if (!(await hasActiveGitHubInstallation())) {
      return { kind: 'skip', reason: 'GitHub is not configured' };
    }

    const selectedRepositories = await getActiveGitHubRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    // Issue Fixer follow-ups must run validation before opening PRs, so the
    // scan only targets repositories backed by a configured environment.
    const environmentBackedRepositories = getEnvironmentBackedCoverage(
      repositoryCoverage,
    ).map((coverage) => coverage.repositoryFullName);

    if (environmentBackedRepositories.length === 0) {
      return {
        kind: 'skip',
        reason: 'No active GitHub repositories have configured environments',
      };
    }

    const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
      automationKey: 'issue_fixer',
      slackChannelId: channelId,
      surface: destination.provider,
    });

    return {
      kind: 'scan',
      payload: {
        repo: ALL_REPOSITORIES,
        selectedRepositories: environmentBackedRepositories,
        description: buildIssueFixerPrompt({
          channelId,
          destination,
          repositoryFullNames: environmentBackedRepositories,
          repositoryCoverage,
          manualTrigger,
          recentThreadFeedback,
        }),
        trigger: 'scheduled',
        ...(destination.provider === 'slack'
          ? { notifySlack: true, slackChannel: channelId }
          : {}),
        suggestionSource: 'issue_fixer',
        visibleInTranscript: false,
      },
    };
  },
});
