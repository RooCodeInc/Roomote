import { buildManagerAutomationRootSummaryPromptContract } from '@roomote/cloud-agents/server';
import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server/non-task-provider-usage';

import {
  completeBackgroundAutomationRun,
  completeBackgroundAutomationRunByJobId,
  db,
  startBackgroundAutomationRun,
  upsertBackgroundAutomationSlackThread,
  slackInstallations,
  taskPullRequests,
  tasks,
  getBackgroundAgentSettingsForDeployment,
  and,
  eq,
  gte,
  isNotNull,
  resolveManagerSlackChannelId,
} from '@roomote/db/server';
import {
  buildAutomationRootSummaryMessage,
  SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';

import { loadAutomationThreadFeedbackContext } from './automation-thread-feedback';
import { hasActiveGitHubInstallation } from './github-deployment-scope';
import { isRunDue, resolveSlackWorkspaceTimezone } from './scheduling-utils';

const LOG_PREFIX = '[announcer]';
const SCHEDULE_HOUR_LOCAL = 2;

interface DeploymentContext {
  slackBotToken: string;
  slackTeamId: string;
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

async function findEligibleDeployments(): Promise<DeploymentContext[]> {
  if (!(await hasActiveGitHubInstallation())) {
    return [];
  }

  return db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));
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

  return `You are writing the top-level Slack summary for an engineering automation that reports merged pull requests.

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

${recentThreadFeedback?.trim() ? `Recent feedback from earlier automation threads:\n${recentThreadFeedback.trim()}\n\n` : ''}${additionalInstructions?.trim() ? `Additional team instructions:\n${additionalInstructions.trim()}\n\n` : ''}Return only the final Slack-formatted message.`;
}

async function runAnnouncerAnalysis(
  mergedPullRequests: MergedPullRequest[],
  additionalInstructions?: string | null,
  recentThreadFeedback?: string | null,
): Promise<string | null> {
  if (mergedPullRequests.length === 0) {
    return null;
  }

  const prompt = buildAnnouncerSummaryPrompt(
    mergedPullRequests,
    additionalInstructions,
    recentThreadFeedback,
  );

  const text = await generateTrackedNonTaskText({
    surface: NON_TASK_INFERENCE_SURFACES.backgroundAnnouncer,
    prompt,
  });

  const cleaned = text.trim();

  return cleaned.length > 0 ? cleaned : null;
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

    let lines = [`*${repo}*`];

    for (const pullRequest of sortedPullRequests) {
      const line = `- ${pullRequest.prTitle} <${pullRequest.prUrl}|#${pullRequest.prNumber}>`;
      const nextMessage = [...lines, line].join('\n');

      if (nextMessage.length > MAX_DETAIL_MESSAGE_CHARS && lines.length > 1) {
        messages.push(lines.join('\n'));
        lines = [`*${repo} (continued)*`, line];
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

export async function announcerJob(
  opts: { manualTrigger?: boolean; bullmqJobId?: string } = {},
): Promise<void> {
  console.log(`${LOG_PREFIX} Starting announcer evaluator`);

  const now = new Date();
  const eligibleDeployments = await findEligibleDeployments();

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const deployment of eligibleDeployments) {
    let runId: string | null = null;

    try {
      const settings = await getBackgroundAgentSettingsForDeployment();

      if (settings.announcerFrequency === 'off') {
        skipped++;
        continue;
      }

      const channelId = resolveManagerSlackChannelId(settings, 'announcer');

      if (!channelId) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: announcer channel not configured`,
        );
        skipped++;
        continue;
      }

      const frequency = settings.announcerFrequency as AnnouncerFrequency;
      const timezone = await resolveSlackWorkspaceTimezone(
        deployment,
        LOG_PREFIX,
      );

      if (
        !opts.manualTrigger &&
        !isRunDue({
          now,
          timeZone: timezone,
          frequency,
          lastRunAt: settings.announcerLastRunAt,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
          windowDays: WINDOW_DAYS,
        })
      ) {
        skipped++;
        continue;
      }

      const windowDays = WINDOW_DAYS[frequency];
      const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const mergedPullRequests = await getMergedPullRequests(since);
      runId = (
        await startBackgroundAutomationRun(db, {
          automationKey: 'announcer',
          bullmqJobId: opts.bullmqJobId ?? `announcer:${crypto.randomUUID()}`,
          triggerKind: opts.manualTrigger ? 'manual' : 'scheduled',
          startedAt: new Date(),
        })
      ).id;

      if (mergedPullRequests.length === 0) {
        console.log(
          `${LOG_PREFIX} Deployment has no merged PRs in current window`,
        );

        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: 'announcer',
          status: 'skipped',
          finishedAt: new Date(),
          metadata: {
            reason: 'no_merged_pull_requests',
          },
        });

        processed++;
        continue;
      }

      const recentThreadFeedback = await loadAutomationThreadFeedbackContext({
        automationKey: 'announcer',
        slackChannelId: channelId,
        now,
      });
      const summary = await runAnnouncerAnalysis(
        mergedPullRequests,
        settings.announcerInstructions,
        recentThreadFeedback,
      );

      if (!summary) {
        console.warn(`${LOG_PREFIX} No summary output; skipping Slack post`);
        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: 'announcer',
          status: 'skipped',
          finishedAt: new Date(),
          metadata: {
            reason: 'empty_summary',
          },
        });
        skipped++;
        continue;
      }

      const notifier = new SlackNotifier(deployment.slackBotToken);
      const message = buildAutomationRootSummaryMessage({
        summaryText: summary,
        automationSettingsHash: SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
      });

      const ts = await notifier.postMessage({
        channel: channelId,
        ...message,
      });

      if (!ts) {
        throw new Error('Failed to post announcer summary to Slack');
      }

      await upsertBackgroundAutomationSlackThread(db, {
        automationKey: 'announcer',
        slackChannelId: channelId,
        threadTs: ts,
        summaryText: summary,
        postedAt: now,
        metadata: {
          mergedCount: mergedPullRequests.length,
          windowDays,
        },
      });

      for (const detailMessage of buildAnnouncerDetailThreadMessages(
        mergedPullRequests,
      )) {
        const detailTs = await notifier.postMessage({
          channel: channelId,
          thread_ts: ts,
          text: detailMessage,
        });

        if (!detailTs) {
          console.warn(
            `${LOG_PREFIX} Failed to post announcer detail thread chunk`,
          );
        }
      }

      await completeBackgroundAutomationRun(db, {
        runId,
        automationKey: 'announcer',
        status: 'succeeded',
        finishedAt: new Date(),
        slackChannelId: channelId,
        threadTs: ts,
        metadata: {
          mergedCount: mergedPullRequests.length,
          windowDays,
        },
      });

      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (runId) {
        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: 'announcer',
          status: 'failed',
          finishedAt: new Date(),
          error: message,
        });
      } else if (opts.bullmqJobId) {
        await completeBackgroundAutomationRunByJobId(db, {
          automationKey: 'announcer',
          bullmqJobId: opts.bullmqJobId,
          status: 'failed',
          finishedAt: new Date(),
          error: message,
        });
      }
      console.error(`${LOG_PREFIX} Failed deployment: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} processed, ${skipped} skipped, ${errors.length} errors`,
  );

  if (errors.length > 0) {
    console.error(`${LOG_PREFIX} Errors:`, errors);
  }
}
