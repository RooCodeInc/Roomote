import { db } from '@roomote/db/server';

import { SLACK_TASK_REPLY_SYNC_TOLERANCE_MS } from '../constants.js';

async function getLatestCloudJobTaskMessage(
  cloudJobId: number,
): Promise<{ ts: number } | null> {
  const latestMessage = await db.query.taskMessages.findFirst({
    where: (taskMessages, { eq }) => eq(taskMessages.runId, cloudJobId),
    orderBy: (taskMessages, { desc }) => [
      desc(taskMessages.ts),
      desc(taskMessages.createdAt),
    ],
    columns: { ts: true },
  });

  return latestMessage ? { ts: latestMessage.ts } : null;
}

function slackTimestampToMs(ts: string): number | null {
  const parsed = Number(ts);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed * 1000;
}

export async function getIsSlackDiverged(params: {
  cloudJobId: number;
  trackedBotReply: { ts: string; text: string; outOfBand?: boolean } | null;
}): Promise<boolean> {
  const { cloudJobId, trackedBotReply } = params;

  if (!trackedBotReply) {
    return true;
  }

  // Out-of-band bot replies (for example background PR review-feedback
  // notifications) are posted outside the task's agent session, so the
  // session has no record of them even though they are the latest bot
  // message in the thread. Treat them as diverged so the follow-up prompt
  // re-surfaces the reply via <replying_to> instead of assuming the session
  // already knows what it said.
  if (trackedBotReply.outOfBand) {
    return true;
  }

  const trackedBotReplyTs = slackTimestampToMs(trackedBotReply.ts);

  if (trackedBotReplyTs === null) {
    return true;
  }

  const latestTaskMessage = await getLatestCloudJobTaskMessage(cloudJobId);

  if (latestTaskMessage === null) {
    return true;
  }

  return (
    latestTaskMessage.ts >
    trackedBotReplyTs + SLACK_TASK_REPLY_SYNC_TOLERANCE_MS
  );
}
