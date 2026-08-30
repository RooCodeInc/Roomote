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
  let settled = false;

  const syncTitle = () => {
    titleUpdate = titleUpdate.then(async () => {
      if (
        !sessionTitle ||
        slackTitle === undefined ||
        slackTitle === sessionTitle
      ) {
        return;
      }
      if (
        await slack.renameAgentSession({
          channel,
          threadTs,
          title: sessionTitle,
        })
      ) {
        slackTitle = sessionTitle;
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
      sessionTitle = normalizeSessionTitle(title);
      if (processingUpdate) {
        void processingUpdate.then(syncTitle);
      }
    },
  };
}
