import {
  buildRepositoryCoverage,
  formatRepositoryEnvironmentLines,
  getEnvironmentBackedCoverage,
  type RepositoryCoverage,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getAutomationTargetRefs,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  type SentryTriageFrequency,
  type SourceControlProvider,
  type SuggestedTasksTask,
} from '@roomote/types';

import { loadAutomationThreadFeedbackReport } from './automation-thread-feedback';
import {
  buildDestinationPromptContext,
  type ResolvedAutomationDestination,
} from './destination';
import {
  getActiveRepositoryFullNames,
  partitionActiveRepositoriesByProvider,
} from './github-deployment-scope';
import {
  createScheduledTriageJob,
  type TriageScanBuild,
} from './scheduled-triage-runner';

const WINDOW_DAYS: Record<Exclude<SentryTriageFrequency, 'off'>, number> = {
  daily: 1,
  weekly: 7,
};

async function hasSentryMcpConnection(): Promise<boolean> {
  const [connection] = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.mcpId, 'sentry'),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
        isNull(mcpConnections.userId),
      ),
    )
    .limit(1);

  return Boolean(connection);
}

function buildSentryFollowUpInstructions(promptContext: {
  surfaceLabel: string;
}): string {
  return `If you find actionable, repository-targeted Sentry follow-up work, submit exactly one \`act\` work item with \`submit_automation_work_items\`: the single highest-priority action from this scan. Do not submit suggestion work items; they are rejected. Only consider repositories that appear in the "Repository environments" list below, copy the matching \`targetEnvironmentId\`, and do not fall back to bare-repo launches. Use actionKind "code_change_pr" for the follow-up. Focus on fixes and instrumentation improvements rather than direct Sentry issue-state changes. Consider the supported recommendation set in that order: fix-now, watch, deprioritize, fingerprint, source-map or release setup, and improve-instrumentation. Write an action-first title such as "Fix ...", "Improve fingerprinting for ...", "Improve instrumentation for ...", "Upload sourcemaps for ...", or "Fix release attribution for ...". Use category "bug" for code defects and "improvement" for instrumentation, fingerprinting, source-map, release-attribution, or observability work. The executionPrompt must open with a conversational investigation sentence that makes it clear the task was looking through Sentry and found something worth fixing. Phrase that opener like a teammate briefly saying what Sentry issue or workflow was checked and what stood out, assuming the ${promptContext.surfaceLabel} reader does not already know the prior context. Do not lead with internal confirmation language like saying the issue "was real" before you say this was a Sentry investigation. After that opener, the executionPrompt must tell the task what to change, what evidence to re-verify first, and what outcome to aim for: a reviewable PR. The work item must use a targetRepositoryFullName from repository_scope and include investigationContext with "$sentry-triage", the intended follow-up, the Sentry issue URL or ID, project, evidence, likely code owner or stack area, the MCP tools or Sentry resources used during triage, and the verification the execution task should perform before editing code. Do not submit a work item unless you are confident which repository should receive the follow-up task.`;
}

function buildSentrySubmissionCloseoutInstruction(promptContext: {
  postToolName: string;
  surfaceLabel: string;
}): string {
  return `If submit_automation_work_items succeeds, do not call ${promptContext.postToolName} and do not post a separate ${promptContext.surfaceLabel} summary; the execution task reports its own result to ${promptContext.surfaceLabel} when it finishes. End the task response with a terse internal note that the work item was submitted.`;
}

function buildSentryTriagePrompt({
  channelId,
  destination,
  frequency,
  projectSlugs,
  repositoryFullNames,
  repositoryCoverage,
  manualTrigger,
  recentThreadFeedback,
}: {
  channelId: string;
  destination: ResolvedAutomationDestination;
  frequency: Exclude<SentryTriageFrequency, 'off'>;
  projectSlugs: string[];
  repositoryFullNames: string[];
  repositoryCoverage: RepositoryCoverage[];
  manualTrigger: boolean;
  recentThreadFeedback?: string | null;
}): string {
  const promptContext = buildDestinationPromptContext(destination);
  const windowDays = WINDOW_DAYS[frequency];
  const projectScope =
    projectSlugs.length > 0
      ? projectSlugs.map((slug) => `- ${slug}`).join('\n')
      : 'All projects available to the configured Sentry connection.';
  const repositoryScope =
    repositoryFullNames.length > 0
      ? repositoryFullNames.map((fullName) => `- ${fullName}`).join('\n')
      : 'No repositories from configured Roomote environments are eligible for launchable follow-up tasks.';
  const repositoryEnvironmentScope =
    formatRepositoryEnvironmentLines(repositoryCoverage);
  const repositoryEnvironmentSection = repositoryEnvironmentScope
    ? `\nRepository environments:\n${repositoryEnvironmentScope}\n`
    : '';

  return `$sentry-triage

<task_context>
  <source>background-automation</source>
  <run_mode>read_only</run_mode>
  <trigger>${manualTrigger ? 'manual' : 'scheduled'}</trigger>
  <scan_window>last ${windowDays} day${windowDays === 1 ? '' : 's'}</scan_window>
  <${promptContext.channelTag}>${channelId}</${promptContext.channelTag}>
  <project_scope>
${projectScope}
  </project_scope>
  <repository_scope>
${repositoryScope}
  </repository_scope>
</task_context>

Run Sentry triage with the Sentry MCP already available in the task environment. Keep this run read-only.

${buildSentryFollowUpInstructions(promptContext)}

${buildSentrySubmissionCloseoutInstruction(promptContext)}

If there are no actionable repository-targeted follow-up actions, no eligible configured-environment repositories, or no configured environment coverage, do not post to ${promptContext.surfaceLabel}; end with a terse internal note. A clean read-only run is not worth a channel message. Post a concise report to the configured ${promptContext.surfaceLabel} channel with ${promptContext.postToolName} only for Sentry MCP setup/auth blockers, so scheduled failures do not disappear. Keep any such report plain-language and manager-readable, and do not paste raw command transcripts into ${promptContext.surfaceLabel}; exact tool usage belongs only in work item investigationContext.

${repositoryEnvironmentSection}

${recentThreadFeedback?.trim() ? `Recent feedback from earlier Sentry triage threads:\n${recentThreadFeedback.trim()}\n` : ''}`;
}

export const sentryTriageJob = createScheduledTriageJob({
  automationKey: 'sentry_triage',
  async buildScanTask({
    deployment,
    channelId,
    destination,
    runtime,
    manualTrigger,
  }) {
    if (!(await hasSentryMcpConnection())) {
      return {
        kind: 'skip',
        reason: 'Sentry MCP is not configured',
      } satisfies TriageScanBuild;
    }

    const frequency = runtime.scheduleMode as SentryTriageFrequency;

    if (frequency !== 'daily' && frequency !== 'weekly') {
      return { kind: 'skip', reason: 'frequency is off' };
    }

    const selectedRepositories = await getActiveRepositoryFullNames();
    const repositoryCoverage =
      await buildRepositoryCoverage(selectedRepositories);
    const environmentBackedRepositories = getEnvironmentBackedCoverage(
      repositoryCoverage,
    ).map((coverage) => coverage.repositoryFullName);
    const recentThreadFeedback = await loadAutomationThreadFeedbackReport({
      automationKey: 'sentry_triage',
      slackChannelId: channelId,
      surface: destination.provider,
    });

    const projectSlugs = getAutomationTargetRefs(
      runtime,
      'sentry',
      'sentry_project',
    );

    const buildPayload = ({
      partitionRepositories,
      partitionCoverage,
      providerStamp,
    }: {
      partitionRepositories: string[];
      partitionCoverage: RepositoryCoverage[];
      providerStamp?: {
        sourceControlProvider: SourceControlProvider;
        sourceControlHost?: string;
      };
    }): SuggestedTasksTask['payload'] => ({
      repo: ALL_REPOSITORIES,
      ...(partitionRepositories.length > 0
        ? { selectedRepositories: partitionRepositories }
        : {}),
      ...providerStamp,
      ...(deployment.slackTeamId ? { teamId: deployment.slackTeamId } : {}),
      description: buildSentryTriagePrompt({
        channelId,
        destination,
        frequency,
        projectSlugs,
        repositoryFullNames: partitionRepositories,
        repositoryCoverage: partitionCoverage,
        manualTrigger,
        recentThreadFeedback: recentThreadFeedback.promptText,
      }),
      trigger: 'scheduled',
      ...(destination.provider === 'slack'
        ? { notifySlack: true, slackChannel: channelId }
        : {}),
      suggestionSource: 'sentry_triage',
      historicalThreadFeedbackDebugSnippet: recentThreadFeedback.debugSnippet,
      visibleInTranscript: false,
    });

    // Sentry issues can map to repositories on any provider, but a run's
    // source-control token is minted for exactly one provider, so a scope
    // that spans providers launches one scan per (provider, host) partition
    // with an explicit stamp. Without repositories in scope the run only
    // reports Sentry MCP blockers, so a single unpartitioned scan launches.
    const partitions = await partitionActiveRepositoriesByProvider(
      environmentBackedRepositories,
    );

    if (partitions.length === 0) {
      return {
        kind: 'scan',
        payloads: [
          buildPayload({
            partitionRepositories: [],
            partitionCoverage: repositoryCoverage,
          }),
        ],
      };
    }

    return {
      kind: 'scan',
      payloads: partitions.map((partition) => {
        const partitionNames = new Set(partition.repositoryFullNames);

        return buildPayload({
          partitionRepositories: partition.repositoryFullNames,
          partitionCoverage: repositoryCoverage.filter((coverage) =>
            partitionNames.has(coverage.repositoryFullName),
          ),
          providerStamp: {
            sourceControlProvider: partition.provider,
            ...(partition.host ? { sourceControlHost: partition.host } : {}),
          },
        });
      }),
    };
  },
});
