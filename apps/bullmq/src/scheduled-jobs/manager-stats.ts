import { Env } from '@roomote/env';
import {
  completeBackgroundAutomationRun,
  completeBackgroundAutomationRunByJobId,
  db,
  slackInstallations,
  getBackgroundAgentSettingsForDeployment,
  startBackgroundAutomationRun,
  eq,
  resolveManagerSlackChannelId,
} from '@roomote/db/server';
import {
  buildAutomationSettingsMessage,
  buildManagerStatsDigest,
  MANAGER_STATS_SETTINGS_HASH,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';
import type { SlackMessage } from '@roomote/slack';

import { hasActiveGitHubInstallation } from './github-deployment-scope';
import {
  isWeeklyRunDueOnLocalDay,
  resolveSlackWorkspaceTimezone,
} from './scheduling-utils';

const LOG_PREFIX = '[managerStats]';
const SCHEDULE_DAY_LOCAL = 5; // Friday.
const SCHEDULE_HOUR_LOCAL = 16;
const WINDOW_DAYS = 7;

interface DeploymentContext {
  slackBotToken: string;
  slackTeamId: string;
  actorUserId: string;
}

function buildAnalyticsUrl() {
  return new URL(
    '/analytics?object=pullRequests',
    Env.ROOMOTE_APP_URL,
  ).toString();
}

function formatManagerStatsText({
  stats,
}: {
  stats: Awaited<ReturnType<typeof buildManagerStatsDigest>>;
}) {
  const topUsers =
    stats.topUsers.length === 0
      ? '—'
      : stats.topUsers
          .map((user) => `${user.label} (${user.pullRequestCount})`)
          .join(', ');
  const lines = [
    '*My weekly stats*',
    `· Active users: *${stats.activeUsers}*`,
    `· PRs opened with me: *${stats.roomotePullRequests} (${Math.round(stats.roomotePullRequestPercentage)}% of ${stats.totalPullRequests})*`,
    `· PR merged with me: *${stats.mergedRoomotePullRequests} (${Math.round(stats.mergedRoomotePullRequestPercentage)}% of ${stats.roomotePullRequests})*`,
    `· LOC added / removed: *+${stats.additions} / -${stats.deletions}*`,
    `· Most active repo: ${
      stats.mostActiveRepo
        ? `*${stats.mostActiveRepo.fullName}* (${stats.mostActiveRepo.pullRequestCount} PRs)`
        : '—'
    }`,
  ];

  if (stats.topUsers.length > 2) {
    lines.push(`· Top users: ${topUsers}`);
  }

  lines.push(`<${buildAnalyticsUrl()}|See more stats>`);

  return lines.join('\n');
}

export function formatManagerStatsMessage({
  stats,
}: {
  stats: Awaited<ReturnType<typeof buildManagerStatsDigest>>;
}): Pick<SlackMessage, 'text' | 'blocks'> {
  const text = formatManagerStatsText({ stats });

  return buildAutomationSettingsMessage(text, MANAGER_STATS_SETTINGS_HASH);
}

async function findEligibleDeployments(): Promise<DeploymentContext[]> {
  if (!(await hasActiveGitHubInstallation())) {
    return [];
  }

  return db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
      actorUserId: slackInstallations.installedByUserId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));
}

export async function managerStatsJob(
  opts: { manualTrigger?: boolean; bullmqJobId?: string } = {},
) {
  console.log(`${LOG_PREFIX} Starting manager stats job`);

  const now = new Date();
  const eligibleDeployments = await findEligibleDeployments();

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const deployment of eligibleDeployments) {
    let runId: string | null = null;

    try {
      const settings = await getBackgroundAgentSettingsForDeployment();
      const channelId = resolveManagerSlackChannelId(settings, 'managerStats');

      if (settings.managerStatsFrequency === 'off') {
        skipped++;
        continue;
      }

      if (!channelId) {
        skipped++;
        continue;
      }

      const timezone = await resolveSlackWorkspaceTimezone(
        deployment,
        LOG_PREFIX,
      );

      if (
        !opts.manualTrigger &&
        !isWeeklyRunDueOnLocalDay({
          now,
          timeZone: timezone,
          lastRunAt: settings.managerStatsLastRunAt,
          scheduleDayLocal: SCHEDULE_DAY_LOCAL,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
        })
      ) {
        skipped++;
        continue;
      }

      const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
      runId = (
        await startBackgroundAutomationRun(db, {
          automationKey: 'manager_stats',
          bullmqJobId:
            opts.bullmqJobId ?? `manager-stats:${crypto.randomUUID()}`,
          triggerKind: opts.manualTrigger ? 'manual' : 'scheduled',
          startedAt: new Date(),
        })
      ).id;

      const stats = await buildManagerStatsDigest({
        actorUserId: deployment.actorUserId,
        since,
      });

      if (stats.activeUsers === 0 && stats.totalPullRequests === 0) {
        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: 'manager_stats',
          status: 'skipped',
          finishedAt: new Date(),
          metadata: {
            reason: 'no_activity',
          },
        });
        processed++;
        continue;
      }

      const slack = new SlackNotifier(deployment.slackBotToken);
      const messageTs = await slack.postMessage({
        channel: channelId,
        ...formatManagerStatsMessage({ stats }),
      });

      if (!messageTs) {
        throw new Error('Failed to post weekly manager stats');
      }

      await completeBackgroundAutomationRun(db, {
        runId,
        automationKey: 'manager_stats',
        status: 'succeeded',
        finishedAt: new Date(),
        slackChannelId: channelId,
        threadTs: messageTs,
      });
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (runId) {
        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: 'manager_stats',
          status: 'failed',
          finishedAt: new Date(),
          error: message,
        });
      } else if (opts.bullmqJobId) {
        await completeBackgroundAutomationRunByJobId(db, {
          automationKey: 'manager_stats',
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
