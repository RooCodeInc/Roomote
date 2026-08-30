import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';
import type { SlackNotifier } from './slack-notifier';

export const FAST_AGENT_SLACK_PROCESSING_DELAY_MS = 300;
const SLACK_AGENT_SESSION_TITLE_MAX_CHARS = 200;

function normalizeSessionTitle(title: string | null | undefined) {
  return title?.trim()
    ? title.slice(0, SLACK_AGENT_SESSION_TITLE_MAX_CHARS)
    : undefined;
}

export function createFastAgentSlackSessionActivity({
  slack,
  channel,
  threadTs,
  title,
  delayMs = FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
}: {
  slack: Pick<SlackNotifier, 'renameAgentSession' | 'setAgentSessionStatus'>;
  channel: string;
  threadTs: string;
  title?: string | null;
  delayMs?: number;
}): FastAgentTurnActivity {
  let sessionTitle = normalizeSessionTitle(title);
  let slackTitle: string | undefined;
  let processingTimer: ReturnType<typeof setTimeout> | undefined;
  let processingUpdate: Promise<void> | undefined;
  let titleUpdate = Promise.resolve();
  let lastRenameAttemptTitle: string | undefined;
  let pendingTitleChange = false;
  let settled = false;

  const syncTitle = (requireSlackTitle = true, retryPendingChange = false) => {
    titleUpdate = titleUpdate.then(async () => {
      const title = sessionTitle;
      const shouldRetryPendingChange = retryPendingChange && pendingTitleChange;
      if (
        !title ||
        title === slackTitle ||
        (title === lastRenameAttemptTitle && !shouldRetryPendingChange) ||
        (requireSlackTitle &&
          slackTitle === undefined &&
          !shouldRetryPendingChange)
      ) {
        return;
      }
      lastRenameAttemptTitle = title;
      try {
        if (
          await slack.renameAgentSession({
            channel,
            threadTs,
            title,
          })
        ) {
          slackTitle = title;
          pendingTitleChange = false;
        }
      } catch {
        // Slack activity is best-effort and must never fail a Fast turn.
      } finally {
        if (shouldRetryPendingChange) {
          pendingTitleChange = false;
        }
      }
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
          if (response.ok) {
            slackTitle = response.title;
            // Slack ignores setStatus.title after creation. A known mismatch
            // still syncs, and a failed persisted-title rename gets one retry
            // after setStatus has had a chance to create the session.
            await syncTitle(true, true);
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
        await syncTitle(true, true);
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
      const updatedTitle = normalizeSessionTitle(title);
      if (!updatedTitle || updatedTitle === sessionTitle) return;

      sessionTitle = updatedTitle;
      pendingTitleChange = true;
      // A generated title is reported only after it has been persisted. Rename
      // directly so short turns and status responses without a title cannot
      // suppress the corresponding Slack notification.
      void syncTitle(false);
    },
  };
}
