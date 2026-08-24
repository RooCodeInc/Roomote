import { randomUUID } from 'node:crypto';

import {
  buildManagerAutomationRootSummaryPromptContract,
  enqueueTask,
} from '@roomote/cloud-agents/server';

import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
  slackInstallations,
  taskPullRequests,
  tasks,
  and,
  eq,
  gte,
  isNotNull,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type FastAutomationExecutionPolicy,
} from '@roomote/types';

import { loadAutomationThreadFeedbackContext } from './automation-thread-feedback';
import {
  listConnectedCommunicationProviders,
  buildDestinationTaskPayloadFields,
  buildDestinationPromptContext,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import { hasAnyActiveRepository } from './github-deployment-scope';
import { resolveDeploymentTimeZone } from './custom-automation-schedule';
import { isRunDue } from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';
import {
  buildScheduledAutomationOccurrenceKey,
  completeFastBuiltInAutomationNoop,
  executeFastBuiltInAutomation,
  recordFastBuiltInAutomationPreflightFailure,
} from './fast-automation-runner';

const LOG_PREFIX = '[announcer]';
const SCHEDULE_HOUR_LOCAL = 2;

interface DeploymentContext {
  slackBotToken: string | null;
  slackTeamId: string | null;
}

function getAnnouncerOccurrencePartition(
  deployment: DeploymentContext,
  destination: ResolvedAutomationDestination | null,
): string {
  if (!destination) {
    return `unresolved:${deployment.slackTeamId ?? 'deployment'}`;
  }

  const workspaceId =
    destination.provider === 'slack'
      ? (destination.teamId ?? deployment.slackTeamId)
      : null;

  return [destination.provider, workspaceId, destination.channelId]
    .filter((part): part is string => Boolean(part))
    .join(':');
}

interface MergedPullRequest {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  mergedAt: Date;
}

type AnnouncerFrequency = 'daily' | 'weekly';

const WINDOW_DAYS: Record<AnnouncerFrequency, number> = {
  daily: 1,
  weekly: 7,
};
const MAX_DETAIL_MESSAGE_CHARS = 3_000;
const ANNOUNCER_FAST_POLICY: FastAutomationExecutionPolicy = {
  version: 1,
  allowedToolsByIntegration: {},
  maxIntegrationCalls: 0,
  maxIntegrationResponseBytes: 500_000,
  maxChildTasks: 0,
  allowedEnvironmentIds: [],
  reporting: 'required',
  childKickoff: 'silent_allowed',
};

async function findEligibleDeployments(): Promise<DeploymentContext[]> {
  // Merged-PR data comes from the provider-neutral taskPullRequests table,
  // so any active repository qualifies regardless of source-control provider.
  if (!(await hasAnyActiveRepository())) {
    return [];
  }

  const rows = await db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  if (rows.length > 0) {
    return rows;
  }

  // No Slack: the deployment is still eligible when another comms provider
  // can carry the announcer's reports.
  const connectedProviders = await listConnectedCommunicationProviders();

  return connectedProviders.length > 0
    ? [{ slackBotToken: null, slackTeamId: null }]
    : [];
}

async function getMergedPullRequests(
  since: Date,
): Promise<MergedPullRequest[]> {
  const rows = await db
    .select({
      repo: taskPullRequests.repository,
      prNumber: taskPullRequests.prNumber,
      prTitle: taskPullRequests.prTitle,
      prUrl: taskPullRequests.prUrl,
      mergedAt: taskPullRequests.detectedAt,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(taskPullRequests.taskId, tasks.id))
    .where(
      and(
        eq(taskPullRequests.status, 'merged'),
        isNotNull(taskPullRequests.repository),
        isNotNull(taskPullRequests.prNumber),
        gte(taskPullRequests.detectedAt, since),
      ),
    )
    .orderBy(taskPullRequests.detectedAt)
    .limit(500);

  const deduped = new Map<string, MergedPullRequest>();

  for (const row of rows) {
    if (!row.repo || row.prNumber === null || !row.prUrl || !row.mergedAt) {
      continue;
    }

    const key = `${row.repo}#${row.prNumber}`;

    deduped.set(key, {
      repo: row.repo,
      prNumber: row.prNumber,
      prTitle: row.prTitle ?? `${row.repo}#${row.prNumber}`,
      prUrl: row.prUrl,
      mergedAt: row.mergedAt,
    });
  }

  return Array.from(deduped.values()).slice(0, 120);
}

function buildAnnouncerSummaryPrompt(
  mergedPullRequests: MergedPullRequest[],
  additionalInstructions?: string | null,
  recentThreadFeedback?: string | null,
): string {
  const items = mergedPullRequests
    .map((pr) => `- ${pr.repo}#${pr.prNumber}: ${pr.prTitle} (${pr.prUrl})`)
    .join('\n');

  return `You are writing the top-level summary for an engineering automation that reports merged pull requests.

The full merged pull request breakdown will be posted in the thread. Write a concise parent message that tells the team what shipped, what stands out, and where to look for the rest.

${buildManagerAutomationRootSummaryPromptContract({
  detailLabel: 'merged pull requests',
  highlightLabel: 'shipped items or themes',
  openerSignal: 'a quick roundup of recently merged pull requests',
  openerExamples: [
    'I just did a quick pass through the latest merged PRs',
    'I took a quick roundup pass on what shipped recently',
  ],
})}

Additional guidance:
- Summarize the main things that shipped. Group related pull requests together when useful.
- Mention repositories only when that makes the summary clearer.

Merged PRs:
${items}

${recentThreadFeedback?.trim() ? `Recent feedback from earlier automation threads:\n${recentThreadFeedback.trim()}\n\n` : ''}${additionalInstructions?.trim() ? `Additional team instructions:\n${additionalInstructions.trim()}\n\n` : ''}Return only the final Markdown message.`;
}

function buildAnnouncerDetailThreadMessages(
  mergedPullRequests: MergedPullRequest[],
): string[] {
  const pullRequestsByRepo = new Map<string, MergedPullRequest[]>();

  for (const pullRequest of mergedPullRequests) {
    const existing = pullRequestsByRepo.get(pullRequest.repo) ?? [];
    existing.push(pullRequest);
    pullRequestsByRepo.set(pullRequest.repo, existing);
  }

  const messages: string[] = [];

  for (const [repo, pullRequests] of Array.from(
    pullRequestsByRepo.entries(),
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const sortedPullRequests = [...pullRequests].sort(
      (left, right) => left.prNumber - right.prNumber,
    );

    let lines = [`**${repo}**`];

    for (const pullRequest of sortedPullRequests) {
      const line = `- ${pullRequest.prTitle} [#${pullRequest.prNumber}](${pullRequest.prUrl})`;
      const nextMessage = [...lines, line].join('\n');

      if (nextMessage.length > MAX_DETAIL_MESSAGE_CHARS && lines.length > 1) {
        messages.push(lines.join('\n'));
        lines = [`**${repo} (continued)**`, line];
        continue;
      }

      lines.push(line);
    }

    if (lines.length > 1) {
      messages.push(lines.join('\n'));
    }
  }

  return messages;
}

function buildAnnouncerTaskDescription(params: {
  destination: ResolvedAutomationDestination;
  mergedPullRequests: MergedPullRequest[];
  instructions?: string | null;
  recentThreadFeedback?: string | null;
}): string {
  const promptContext = buildDestinationPromptContext(params.destination);
  const detailMessages = buildAnnouncerDetailThreadMessages(
    params.mergedPullRequests,
  );

  return `${buildAnnouncerSummaryPrompt(
    params.mergedPullRequests,
    params.instructions,
    params.recentThreadFeedback,
  )}

Post the summary with \`send_chat_reply\`. Your first reply creates the report thread in the configured ${promptContext.surfaceLabel} channel. Then post each of these exact detail chunks as a separate \`send_chat_reply\` in that same thread:

${detailMessages.map((message) => `---\n${message}`).join('\n')}

Do not send an acknowledgement or progress update. Treat later replies in this thread as follow-up questions about the digest.`;
}

function buildAnnouncerFastPrompt(params: {
  mergedPullRequests: MergedPullRequest[];
  instructions?: string | null;
  recentThreadFeedback?: string | null;
}): string {
  const detailMessages = buildAnnouncerDetailThreadMessages(
    params.mergedPullRequests,
  );
  return `${buildAnnouncerSummaryPrompt(
    params.mergedPullRequests,
    params.instructions,
    params.recentThreadFeedback,
  )}

Post the summary with \`send_chat_reply\` using purpose \`closeout\` and logicalMessageKey \`summary\`. Then post each exact detail chunk below with purpose \`closeout\` and logicalMessageKey \`detail-1\`, \`detail-2\`, and so on. Do not alter the detail chunks.

${detailMessages.map((message, index) => `--- detail-${index + 1}\n${message}`).join('\n')}

After every message is delivered, call \`complete_automation_run\` with outcome \`succeeded\`. Do not add final prose.`;
}

export async function announcerJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting announcer evaluator`);

  const now = new Date();
  const result = emptyJobResult();
  const eligibleDeployments = await findEligibleDeployments();

  if (eligibleDeployments.length === 0) {
    result.skippedReason =
      'An active repository and a communication provider must both be connected.';
  }

  let processed = 0;
  let skipped = 0;
  let passLastRunAt: Date | null = null;
  let hasPassLastRunAt = false;

  for (const deployment of eligibleDeployments) {
    let failureRuntime: Awaited<
      ReturnType<typeof getAutomationRuntime>
    > | null = null;
    let failureDestination: ResolvedAutomationDestination | null = null;
    let failureFrequency = 'unknown';
    let failureTimeZone = 'UTC';
    let fastExecutionStarted = false;
    const manualOccurrenceKey = opts.manualTrigger
      ? `manual:${randomUUID()}`
      : null;
    try {
      const runtime = await getAutomationRuntime('announcer');
      if (!hasPassLastRunAt) {
        passLastRunAt = runtime.lastRunAt;
        hasPassLastRunAt = true;
      }
      const frequency = runtime.enabled ? runtime.scheduleMode : 'off';
      failureRuntime = runtime;
      failureFrequency = frequency ?? 'off';

      if (!frequency || frequency === 'off' || !(frequency in WINDOW_DAYS)) {
        result.skippedReason = 'Automation is disabled.';
        skipped++;
        continue;
      }

      const destination =
        opts.destination ??
        (await resolveAutomationRuntimeDestination({
          runtime,
          slackConnected: deployment.slackBotToken !== null,
        }));
      failureDestination = destination;

      if (!destination) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: announcer channel not configured`,
        );
        result.skippedReason = 'Announcer channel is not configured.';
        skipped++;
        continue;
      }

      const channelId = destination.channelId;
      const timezone = (await resolveDeploymentTimeZone()).timeZone;
      failureTimeZone = timezone;

      if (
        !opts.manualTrigger &&
        !isRunDue({
          now,
          timeZone: timezone,
          frequency: frequency as AnnouncerFrequency,
          lastRunAt: passLastRunAt,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
          windowDays: WINDOW_DAYS,
        })
      ) {
        result.skippedReason = 'Not due yet.';
        skipped++;
        continue;
      }

      const windowDays = WINDOW_DAYS[frequency as AnnouncerFrequency];
      const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const mergedPullRequests = await getMergedPullRequests(since);

      if (mergedPullRequests.length === 0) {
        console.log(
          `${LOG_PREFIX} Deployment has no merged PRs in current window`,
        );

        if (runtime.executionRoute === 'fast') {
          fastExecutionStarted = true;
          await completeFastBuiltInAutomationNoop({
            automationKey: 'announcer',
            triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
            occurrenceKey: opts.manualTrigger
              ? manualOccurrenceKey!
              : buildScheduledAutomationOccurrenceKey({
                  automationKey: 'announcer',
                  frequency,
                  now,
                  timeZone: timezone,
                  partition: getAnnouncerOccurrencePartition(
                    deployment,
                    destination,
                  ),
                }),
            prompt: 'No merged pull requests were found in the bounded window.',
            policy: ANNOUNCER_FAST_POLICY,
            destination,
          });
        } else {
          await recordAutomationRunOutcome(db, {
            key: 'announcer',
            status: 'skipped',
            at: new Date(),
          });
        }

        result.skippedReason = 'No merged pull requests in the window.';
        processed++;
        continue;
      }

      const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
        automationKey: 'announcer',
        slackChannelId: channelId,
        surface: destination.provider,
        now,
      });
      if (runtime.executionRoute === 'fast') {
        fastExecutionStarted = true;
        const fastResult = await executeFastBuiltInAutomation({
          automationKey: 'announcer',
          triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
          occurrenceKey: opts.manualTrigger
            ? manualOccurrenceKey!
            : buildScheduledAutomationOccurrenceKey({
                automationKey: 'announcer',
                frequency,
                now,
                timeZone: timezone,
                partition: getAnnouncerOccurrencePartition(
                  deployment,
                  destination,
                ),
              }),
          prompt: buildAnnouncerFastPrompt({
            mergedPullRequests,
            instructions: runtime.instructions,
            recentThreadFeedback,
          }),
          policy: ANNOUNCER_FAST_POLICY,
          destination,
        });
        result.completed = fastResult.status !== 'failed';
        processed++;
        continue;
      }
      await enqueueTask({
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: ALL_REPOSITORIES,
            description: buildAnnouncerTaskDescription({
              destination,
              mergedPullRequests,
              instructions: runtime.instructions,
              recentThreadFeedback,
            }),
            ...buildDestinationTaskPayloadFields(destination),
            backgroundAutomationKey: 'announcer',
            ...(destination.provider === 'slack'
              ? {
                  channel: channelId,
                  slackChannel: channelId,
                }
              : {}),
          },
        },
        title: 'Summarize merged pull requests',
        initiator: { kind: 'automation', key: 'announcer' },
        workflow: 'standard',
        surface: 'system',
        trigger: opts.manualTrigger ? 'manual' : 'schedule',
        ...(destination.provider === 'slack'
          ? { channels: { slackChannelId: channelId } }
          : {}),
      });

      await recordAutomationRunOutcome(db, {
        key: 'announcer',
        status: 'succeeded',
        at: new Date(),
      });

      result.completed = true;
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      if (failureRuntime?.executionRoute === 'fast' && !fastExecutionStarted) {
        await recordFastBuiltInAutomationPreflightFailure({
          automationKey: 'announcer',
          triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
          occurrenceKey:
            manualOccurrenceKey ??
            buildScheduledAutomationOccurrenceKey({
              automationKey: 'announcer',
              frequency: failureFrequency,
              now,
              timeZone: failureTimeZone,
              partition: getAnnouncerOccurrencePartition(
                deployment,
                failureDestination,
              ),
            }),
          policy: ANNOUNCER_FAST_POLICY,
          destination: failureDestination,
          error: message,
        });
      }
      await recordAutomationRunOutcome(db, {
        key: 'announcer',
        status: 'failed',
        at: new Date(),
        error: message,
      });
      console.error(`${LOG_PREFIX} Failed deployment: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} processed, ${skipped} skipped, ${result.errors.length} errors`,
  );

  if (result.errors.length > 0) {
    console.error(`${LOG_PREFIX} Errors:`, result.errors);
  }

  return result;
}
