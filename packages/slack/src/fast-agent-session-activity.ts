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
  let disposed = false;
  let settlement: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;

  const cancelProcessingTimer = () => {
    clearTimeout(processingTimer);
    processingTimer = undefined;
  };

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
      if (processingTimer || processingUpdate || settled || disposed) return;

      processingTimer = setTimeout(() => {
        processingTimer = undefined;
        processingUpdate = (async () => {
          const response = await slack.setAgentSessionStatus({
            channel,
            threadTs,
            status: 'processing',
          });
          processingSucceeded = response.ok;
          if (response.ok) {
            await queueTitleSync(response.title);
          }
        })().catch((error) => {
          console.warn(
            '[Fast Agent] Failed to start Slack session activity:',
            error,
          );
        });
      }, delayMs);
      processingTimer.unref?.();
    },
    settle({ keepProcessing = false } = {}) {
      if (settlement) return settlement;
      settled = true;
      cancelProcessingTimer();
      settlement = (async () => {
        if (disposed) return;
        if (!processingUpdate) {
          // Create the session during settlement; late titles must not reset a newer turn's status.
          const response = await slack.setAgentSessionStatus({
            channel,
            threadTs,
            status: keepProcessing ? 'processing' : 'active',
          });
          processingSucceeded = response.ok;
          if (response.ok) {
            await queueTitleSync(response.title);
          }
          return;
        }

        try {
          await processingUpdate;
          await queueTitleSync();
        } finally {
          if (!disposed && !keepProcessing)
            await slack.setAgentSessionStatus({
              channel,
              threadTs,
              status: 'active',
            });
        }
      })();
      return settlement;
    },
    dispose() {
      disposed = true;
      cancelProcessingTimer();
      disposal ??= Promise.allSettled([processingUpdate, settlement]).then(
        () => undefined,
      );
      return disposal;
    },
    updateTitle(title) {
      sessionTitle = normalizeSlackAgentSessionTitle(title);
      if (processingUpdate) {
        void processingUpdate
          .then(() => queueTitleSync())
          .catch((error) => {
            console.warn(
              '[Fast Agent] Failed to sync Slack session title:',
              error,
            );
          });
      } else if (settled) {
        void queueTitleSync().catch((error) => {
          console.warn(
            '[Fast Agent] Failed to sync Slack session title:',
            error,
          );
        });
      }
    },
  };
}
