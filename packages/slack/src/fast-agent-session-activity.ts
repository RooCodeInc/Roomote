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
  let settled = false;

  const syncTitle = (requireSlackTitle = true) => {
    titleUpdate = titleUpdate.then(async () => {
      const title = sessionTitle;
      if (
        !title ||
        title === slackTitle ||
        title === lastRenameAttemptTitle ||
        (requireSlackTitle && slackTitle === undefined)
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
        }
      } catch {
        // Slack activity is best-effort and must never fail a Fast turn.
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
            // Slack ignores setStatus.title after creation, so rename only
            // when its response proves an existing session has another title.
            await syncTitle();
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
        await syncTitle();
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
      // A generated title is reported only after it has been persisted. Rename
      // directly so short turns and status responses without a title cannot
      // suppress the corresponding Slack notification.
      void syncTitle(false);
    },
  };
}
