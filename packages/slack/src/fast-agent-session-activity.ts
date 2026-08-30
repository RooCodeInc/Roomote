import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';
import {
  normalizeSlackAgentSessionTitle,
  syncSlackAgentSessionTitleBestEffort,
} from './agent-session-title-sync';
import type { SlackNotifier } from './slack-notifier';

export const FAST_AGENT_SLACK_PROCESSING_DELAY_MS = 300;

export function createFastAgentSlackSessionActivity({
  slack,
  channel,
  threadTs,
  workspaceId,
  title,
  resolveTitle,
  syncTitle = syncSlackAgentSessionTitleBestEffort,
  delayMs = FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
}: {
  slack: Pick<SlackNotifier, 'renameAgentSession' | 'setAgentSessionStatus'>;
  channel: string;
  threadTs: string;
  workspaceId: string;
  title?: string | null;
  resolveTitle?: () => Promise<string | null | undefined>;
  syncTitle?: typeof syncSlackAgentSessionTitleBestEffort;
  delayMs?: number;
}): FastAgentTurnActivity {
  let sessionTitle = normalizeSlackAgentSessionTitle(title);
  let processingTimer: ReturnType<typeof setTimeout> | undefined;
  let processingUpdate: Promise<void> | undefined;
  let processingSucceeded = false;
  let titleUpdate = Promise.resolve();
  let settled = false;

  const queueTitleSync = (reportedTitle?: string) => {
    const title = sessionTitle;
    if (!processingSucceeded || !title) return titleUpdate;

    titleUpdate = titleUpdate.then(async () => {
      await syncTitle({
        slack,
        workspaceId,
        channel,
        threadTs,
        title,
        reportedTitle,
        resolveTitle: resolveTitle ?? (async () => sessionTitle),
      });
    });
    return titleUpdate;
  };

  return {
    start() {
      if (processingTimer || processingUpdate || settled) return;

      processingTimer = setTimeout(() => {
        processingTimer = undefined;
        processingUpdate = (async () => {
          const response = await slack.setAgentSessionStatus({
            channel,
            threadTs,
            status: 'processing',
            ...(sessionTitle ? { title: sessionTitle } : {}),
          });
          processingSucceeded = response.ok;
          if (response.ok) {
            await queueTitleSync(response.title);
          }
        })();
      }, delayMs);
      processingTimer.unref?.();
    },
    async settle() {
      if (settled) return;
      settled = true;

      if (processingTimer) {
        clearTimeout(processingTimer);
        processingTimer = undefined;
      }
      if (!processingUpdate) return;

      try {
        await processingUpdate;
        await queueTitleSync();
      } finally {
        await slack.setAgentSessionStatus({
          channel,
          threadTs,
          status: 'active',
          ...(sessionTitle ? { title: sessionTitle } : {}),
        });
      }
    },
    updateTitle(title) {
      sessionTitle = normalizeSlackAgentSessionTitle(title);
      if (processingUpdate) {
        void processingUpdate.then(() => queueTitleSync());
      }
    },
  };
}
