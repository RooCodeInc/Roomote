import { Env } from '@roomote/env';
import {
  db,
  getAutomationRuntime,
  githubInstallations,
  isNull,
  recordAutomationRunOutcome,
  slackInstallations,
  eq,
} from '@roomote/db/server';
import { MANAGER_STATS_SETTINGS_HASH } from '@roomote/types';
import { SlackNotifier } from '@roomote/slack';
import type { SlackMessage } from '@roomote/slack';

import { getCommunicationProviderAdapter } from '../lib/communication-providers';
import {
  buildAutomationSettingsMessage,
  buildManagerSlackSettingsUrl,
  degradeSlackMrkdwnToMarkdown,
} from '../lib/manager-slack';
import { buildManagerStatsDigest } from '../lib/manager-stats';
import {
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import { hasAnyActiveRepository } from './github-deployment-scope';
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
  slackBotToken: string | null;
  slackTeamId: string | null;
  /**
   * User the GitHub data path runs as; null when the deployment has no Slack
   * installer and no GitHub installation (e.g. GitLab + Teams). The digest
   * then covers the non-GitHub repositories only, which is the whole set.
   */
  actorUserId: string | null;
}

function buildAnalyticsUrl() {
  return new URL('/analytics?object=pullRequests', Env.R_APP_URL).toString();
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
    `· PRs opened with me: *${stats.roomotePullRequests} (${Math.round(stats.roomotePullRequestPercentage)}% of ${stats.totalPullRequests})* — ${stats.authoredPullRequests} authored, ${stats.reviewedPullRequests} reviewed`,
    `· PR merged with me: *${stats.mergedRoomotePullRequests} (${Math.round(stats.mergedRoomotePullRequestPercentage)}% of ${stats.authoredPullRequests} authored)*`,
    // Line counts are only available from GitHub; when the digest includes
    // PRs from other providers, say so instead of implying full coverage.
    `· LOC added / removed: *+${stats.additions} / -${stats.deletions}*${
      stats.locScope === 'github_only' ? ' (GitHub PRs only)' : ''
    }`,
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
  // PR stats come from the provider-neutral digest, so any active repository
  // qualifies regardless of source-control provider.
  if (!(await hasAnyActiveRepository())) {
    return [];
  }

  const rows = await db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
      actorUserId: slackInstallations.installedByUserId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  if (rows.length > 0) {
    return rows;
  }

  // No Slack: the deployment is still eligible when another comms provider
  // can carry the stats report. GitHub calls then run as the user who
  // installed the GitHub App; without a GitHub installation there is no
  // GitHub data path to authenticate, so no actor is needed.
  const connectedProviders = await listConnectedCommunicationProviders();

  if (connectedProviders.length === 0) {
    return [];
  }

  const [installation] = await db
    .select({ actorUserId: githubInstallations.installedByUserId })
    .from(githubInstallations)
    .where(isNull(githubInstallations.suspendedAt))
    .limit(1);

  return [
    {
      slackBotToken: null,
      slackTeamId: null,
      actorUserId: installation?.actorUserId ?? null,
    },
  ];
}

/**
 * Posts the weekly stats to a non-Slack destination through its
 * communication provider adapter: the Slack mrkdwn digest degraded to
 * standard markdown, with the automation-settings context degraded to a
 * link button.
 */
async function postManagerStatsViaCommunicationAdapter(params: {
  destination: ResolvedAutomationDestination;
  stats: Awaited<ReturnType<typeof buildManagerStatsDigest>>;
}): Promise<void> {
  const { destination } = params;
  const adapter = await getCommunicationProviderAdapter(destination.provider);

  if (!adapter) {
    throw new Error(
      `Failed to post weekly manager stats: ${destination.provider} is not connected`,
    );
  }

  await adapter.postMessage({
    channelId: destination.channelId,
    ...(destination.serviceUrl ? { serviceUrl: destination.serviceUrl } : {}),
    text: degradeSlackMrkdwnToMarkdown(
      formatManagerStatsText({ stats: params.stats }),
    ),
    textFormat: 'markdown',
    buttons: [
      [
        {
          text: 'Automation settings',
          url: buildManagerSlackSettingsUrl(MANAGER_STATS_SETTINGS_HASH),
        },
      ],
    ],
  });
}

export async function managerStatsJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting manager stats job`);

  const now = new Date();
  const result = emptyJobResult();
  const eligibleDeployments = await findEligibleDeployments();

  if (eligibleDeployments.length === 0) {
    result.skippedReason =
      'A repository and a communication provider must both be connected.';
  }

  let processed = 0;
  let skipped = 0;

  for (const deployment of eligibleDeployments) {
    try {
      const runtime = await getAutomationRuntime('manager_stats');
      const frequency = runtime.enabled ? runtime.scheduleMode : 'off';

      if (!frequency || frequency === 'off') {
        result.skippedReason = 'Automation is disabled.';
        skipped++;
        continue;
      }

      const destination = await resolveAutomationRuntimeDestination({
        runtime,
        slackConnected: deployment.slackBotToken !== null,
      });

      if (!destination) {
        result.skippedReason = 'Manager channel is not configured.';
        skipped++;
        continue;
      }

      const channelId = destination.channelId;
      const timezone = deployment.slackBotToken
        ? await resolveSlackWorkspaceTimezone(
            {
              slackBotToken: deployment.slackBotToken,
              slackTeamId: deployment.slackTeamId ?? '',
            },
            LOG_PREFIX,
          )
        : 'UTC';

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

      if (destination.provider === 'slack') {
        if (!deployment.slackBotToken) {
          throw new Error(
            'Manager stats destination is Slack, but Slack is not connected',
          );
        }

        const slack = new SlackNotifier(deployment.slackBotToken);
        const messageTs = await slack.postMessage({
          channel: channelId,
          ...formatManagerStatsMessage({ stats }),
        });

        if (!messageTs) {
          throw new Error('Failed to post weekly manager stats');
        }
      } else {
        await postManagerStatsViaCommunicationAdapter({ destination, stats });
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
