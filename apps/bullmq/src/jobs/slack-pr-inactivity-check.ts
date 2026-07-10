import { Job } from 'bullmq';

import { db, eq, slackInstallations, taskRuns } from '@roomote/db/server';
import {
  fetchPullRequestSnapshotForCloudJob,
  hasPullRequestMoved,
  isPullRequestTerminal,
  type SlackPrInactivityCheckRequest,
  slackPrInactivityCheckRequestSchema,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';

function getPullRequestUrl({
  repository,
  prNumber,
}: {
  repository: string;
  prNumber: number;
}): string {
  return `https://github.com/${repository}/pull/${prNumber}`;
}

function getNudgeText({
  repository,
  prNumber,
}: {
  repository: string;
  prNumber: number;
}): string {
  const prUrl = getPullRequestUrl({ repository, prNumber });

  return `Hey, just checking if you're still interested in <${prUrl}|this PR>.`;
}

type SlackPrInactivityCheckJob = Job<
  SlackPrInactivityCheckRequest,
  void,
  string
>;

export const slackPrInactivityCheckJob = async (
  job: SlackPrInactivityCheckJob,
): Promise<void> => {
  const parsed = slackPrInactivityCheckRequestSchema.safeParse(job.data);

  if (!parsed.success) {
    throw new Error(
      `[SlackPrInactivityCheck] Invalid job data: ${parsed.error.message}`,
    );
  }

  const data = parsed.data;

  const cloudJob = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, data.cloudJobId),
  });

  if (!cloudJob) {
    console.warn(
      `[SlackPrInactivityCheck] Source run ${data.cloudJobId} not found, skipping`,
    );
    return;
  }

  const currentSnapshot = await fetchPullRequestSnapshotForCloudJob({
    cloudJob,
    repository: data.repository,
    prNumber: data.prNumber,
  });

  if (!currentSnapshot) {
    console.warn(
      `[SlackPrInactivityCheck] Failed to fetch current PR snapshot for ${data.repository}#${data.prNumber}, skipping`,
    );
    return;
  }

  if (isPullRequestTerminal(currentSnapshot)) {
    console.log(
      `[SlackPrInactivityCheck] PR is already terminal for ${data.repository}#${data.prNumber}, skipping nudge`,
    );
    return;
  }

  if (
    hasPullRequestMoved({
      baseline: data.baseline,
      current: currentSnapshot,
    })
  ) {
    console.log(
      `[SlackPrInactivityCheck] PR moved for ${data.repository}#${data.prNumber}, no nudge needed`,
    );
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      `[SlackPrInactivityCheck] No active Slack installation, skipping nudge`,
    );
    return;
  }

  const notifier = new SlackNotifier(slackInstallation.botAccessToken);

  await notifier.postMessage({
    channel: data.channel,
    thread_ts: data.threadTs,
    text: getNudgeText({
      repository: data.repository,
      prNumber: data.prNumber,
    }),
    unfurl_links: false,
    unfurl_media: false,
  });

  console.log(
    `[SlackPrInactivityCheck] Posted nudge for ${data.repository}#${data.prNumber} in thread ${data.threadTs}`,
  );
};
