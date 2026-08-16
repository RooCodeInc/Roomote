import {
  buildRepositoryCoverage,
  formatRepositoryEnvironmentLines,
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
  const followUpInstructions = `For every repository in scope, count its current open Dependabot alerts and inspect its open pull requests for dependency updates or alert references that could already address them. Treat a related open PR as in-flight remediation: do not submit duplicate work for alerts it covers, but include it in the scan summary and identify any alerts it does not cover.

If you find actionable candidates, submit up to 3 \`act\` automation work items with \`submit_automation_work_items\`. Do not submit any suggestion work items; they are rejected. Submit at most one work item for each \`targetEnvironmentId\`. Only consider repositories that appear in the "Repository environments" list below. Do not fall back to bare-repo launches. Submit one cohesive remediation bundle for every eligible environment with uncovered actionable alerts, in priority order, until the three-item cap is reached. Do not stop after the single highest-priority bundle when other eligible environments have independent uncovered alerts. For a repository with multiple related lockfile or dependency alerts, create one task that aims to resolve every actionable open alert in that cohesive bundle, not only the first alert inspected. Start with the narrowest security fix that is likely to work, but if the alerts realistically need an aligned lockfile refresh, multiple affected workspaces, or a small related dependency bundle, submit that broader cohesive remediation instead of deferring. Do not turn unrelated alerts into a broad maintenance sweep.

Each submitted act item must:
- target exactly one repository from repository_scope
- copy the matching \`targetEnvironmentId\` from the "Repository environments" list
- include \`executionPrompt\` that starts with \`$update-dependencies\`
- explicitly state in \`executionPrompt\` that the remediation must not modify or bypass dependency minimum-age policy, including pnpm \`minimumReleaseAge\` and \`minimumReleaseAgeExclude\`; use only versions allowed by the existing policy
- state that success means re-checking the targeted alert bundle and leaving no actionable alerts from that bundle open, unless an existing related PR already covers them
- include investigationContext with the alert URL or number, alert summary, package, ecosystem, manifest path, severity, vulnerable range, first patched version, related open PRs and the alerts they cover, the exact GitHub CLI commands used during triage, and the validation the execution task must perform before opening a PR

Do not post any ${promptContext.surfaceLabel} opening acknowledgement, scan announcement, progress update, or partial finding. After triage reaches a final result, send exactly one concise report with \`send_chat_reply\` using purpose \`closeout\`; the first reply creates the standard automation result thread in the configured ${promptContext.surfaceLabel} conversation. State the total number of open Dependabot alerts with a critical/high/medium/low severity breakdown, the per-repository counts, related open PRs (or that none are open), and how many currently open alerts are covered by newly started remediation task(s), existing related PRs, or neither. Keep it manager-readable and do not paste raw GitHub CLI commands, \`gh api\` invocations, or command transcripts. End the task response with a terse internal note after sending the final report.

Treat repository-level gaps such as Dependabot alerts being disabled for a repository, a repository returning zero open alerts, or a repository falling outside configured environment coverage as reportable scan outcomes, not as GitHub setup/auth blockers. If GitHub setup or alert access is blocked, send the same concise report with the blocker and the counts that could be determined.`;

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

    // Dependabot alerts only exist on GitHub, so the scan scope must never
    // include repositories from other providers: a mixed-provider scope
    // leaves the run's source-control provider ambiguous and GitHub token
    // minting then fails on the non-GitHub repository names.
    const selectedRepositories = await getActiveGitHubRepositoryFullNames();
    if (selectedRepositories.length === 0) {
      return {
        kind: 'skip',
        reason: 'No active GitHub repositories',
      };
    }

    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
      automationKey: 'dependabot_triage',
      slackChannelId: channelId,
      surface: destination.provider,
    });

    return {
      kind: 'scan',
      payloads: [
        {
          repo: ALL_REPOSITORIES,
          selectedRepositories,
          sourceControlProvider: 'github',
          description: buildDependabotTriagePrompt({
            channelId,
            destination,
            repositoryFullNames: selectedRepositories,
            repositoryCoverage,
            manualTrigger,
            recentThreadFeedback,
          }),
          trigger: 'scheduled',
          ...(destination.provider === 'slack'
            ? { notifySlack: false, slackChannel: channelId }
            : {}),
          suggestionSource: 'dependabot_triage',
          visibleInTranscript: false,
        },
      ],
    };
  },
});
