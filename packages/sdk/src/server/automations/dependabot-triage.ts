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
  getActiveRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
import { createScheduledTriageJob } from './scheduled-triage-runner';

function buildDependabotTriagePrompt({
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
  const followUpInstructions = `If you find actionable candidates, submit up to 3 \`act\` automation work items with \`submit_automation_work_items\`. Do not submit any suggestion work items; they are rejected. Submit at most one work item for each \`targetEnvironmentId\`. Only consider repositories that appear in the "Repository environments" list below. Do not fall back to bare-repo launches. Pick the highest-priority cohesive update bundles across the eligible repositories. Start with the narrowest security fix that is likely to work, but if the alert realistically needs an aligned lockfile refresh, multiple affected workspaces, or a small related dependency bundle, submit that broader cohesive remediation instead of deferring. Do not turn one alert into a broad maintenance sweep.

Each submitted act item must:
- target exactly one repository from repository_scope
- copy the matching \`targetEnvironmentId\` from the "Repository environments" list
- include \`executionPrompt\` that starts with \`$update-dependencies\`
- include investigationContext with the alert URL or number, alert summary, package, ecosystem, manifest path, severity, vulnerable range, first patched version, the exact GitHub CLI commands used during triage, and the validation the execution task must perform before opening a PR

If \`submit_automation_work_items\` succeeds for one or more act items, do not call \`${promptContext.postToolName}\` and do not post a launch announcement. Each execution task starts silently and creates ${promptContext.surfaceLabel} output only later if it needs input, hits a blocker, or finishes with a result. End the task response with a terse internal note that action items were submitted.

If there are no actionable alerts, no eligible configured-environment candidates, or no configured environment coverage, do not post to ${promptContext.surfaceLabel}; end with a terse internal note. Treat repository-level gaps such as Dependabot alerts being disabled for a repository, a repository returning zero open alerts, or a repository falling outside configured environment coverage as non-blocking no-op findings for this run, not as GitHub setup/auth blockers worth a ${promptContext.surfaceLabel} post. A clean read-only run is not worth a channel message. Post a concise report to the configured ${promptContext.surfaceLabel} channel with \`${promptContext.postToolName}\` only for GitHub setup/auth blockers (for example missing or suspended Dependabot alert access), so configuration failures do not disappear silently. Keep any such report plain-language and manager-readable, and do not paste the raw GitHub CLI commands, \`gh api\` invocations, or command transcripts into ${promptContext.surfaceLabel}; the exact commands belong only in work item \`investigationContext\`.`;

  return `$dependabot-triage

<task_context>
  <source>background-automation</source>
  <run_mode>read_only</run_mode>
  <trigger>${manualTrigger ? 'manual' : 'scheduled'}</trigger>
  <alert_scope>current_open_dependabot_alerts</alert_scope>
  <${promptContext.channelTag}>${channelId}</${promptContext.channelTag}>
  <repository_scope>
${repositoryScope}
  </repository_scope>
</task_context>

Run Dependabot triage with the GitHub access already available in the task environment. Keep this run read-only.

${followUpInstructions}

${repositoryEnvironmentSection}

${recentThreadFeedback?.trim() ? `Recent feedback from earlier Dependabot triage threads:\n${recentThreadFeedback.trim()}\n` : ''}`;
}

export const dependabotTriageJob = createScheduledTriageJob({
  automationKey: 'dependabot_triage',
  async buildScanTask({ channelId, destination, manualTrigger }) {
    if (!(await hasActiveGitHubInstallation())) {
      return { kind: 'skip', reason: 'GitHub is not configured' };
    }

    const selectedRepositories = await getActiveRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    // Dependabot follow-ups must run validation before opening PRs, so the
    // scan only targets repositories backed by a configured environment.
    const environmentBackedRepositories = getEnvironmentBackedCoverage(
      repositoryCoverage,
    ).map((coverage) => coverage.repositoryFullName);
    const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
      automationKey: 'dependabot_triage',
      slackChannelId: channelId,
      surface: destination.provider,
    });

    return {
      kind: 'scan',
      payload: {
        repo: ALL_REPOSITORIES,
        ...(environmentBackedRepositories.length > 0
          ? { selectedRepositories: environmentBackedRepositories }
          : {}),
        description: buildDependabotTriagePrompt({
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
        suggestionSource: 'dependabot_triage',
        visibleInTranscript: false,
      },
    };
  },
});
