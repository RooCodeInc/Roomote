import { Env } from '@roomote/env';
import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
  slackInstallations,
  eq,
} from '@roomote/db/server';
import { MANAGER_STATS_SETTINGS_HASH } from '@roomote/types';
import { SlackNotifier } from '@roomote/slack';
import type { SlackMessage } from '@roomote/slack';

import { buildAutomationSettingsMessage } from '../lib/manager-slack';
import { buildManagerStatsDigest } from '../lib/manager-stats';
import { hasActiveGitHubInstallation } from './github-deployment-scope';
import {
  isWeeklyRunDueOnLocalDay,
  resolveSlackWorkspaceTimezone,
} from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

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
  return new URL('/analytics', Env.ROOMOTE_APP_URL).toString();
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
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting manager stats job`);

  const now = new Date();
  const result = emptyJobResult();
  const eligibleDeployments = await findEligibleDeployments();

  if (eligibleDeployments.length === 0) {
    result.skippedReason = 'GitHub and Slack must both be connected.';
  }

  let processed = 0;
  let skipped = 0;

  for (const deployment of eligibleDeployments) {
    try {
      const runtime = await getAutomationRuntime('manager_stats');
      const frequency = runtime.enabled ? runtime.scheduleMode : 'off';
      const channelId = runtime.slackChannelId;

      if (!frequency || frequency === 'off') {
        result.skippedReason = 'Automation is disabled.';
        skipped++;
        continue;
      }

      if (!channelId) {
        result.skippedReason = 'Manager channel is not configured.';
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
          lastRunAt: runtime.lastRunAt,
          scheduleDayLocal: SCHEDULE_DAY_LOCAL,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
        })
      ) {
        result.skippedReason = 'Not due yet.';
        skipped++;
        continue;
      }

      const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const stats = await buildManagerStatsDigest({
        actorUserId: deployment.actorUserId,
        since,
      });

      if (stats.activeUsers === 0 && stats.totalPullRequests === 0) {
        await recordAutomationRunOutcome(db, {
          key: 'manager_stats',
          status: 'skipped',
          at: new Date(),
        });
        result.skippedReason = 'No activity in the stats window.';
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

      await recordAutomationRunOutcome(db, {
        key: 'manager_stats',
        status: 'succeeded',
        at: new Date(),
      });
      result.completed = true;
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      await recordAutomationRunOutcome(db, {
        key: 'manager_stats',
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
