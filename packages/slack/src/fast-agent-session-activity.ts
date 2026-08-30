import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';
import type { SlackNotifier } from './slack-notifier';

export const FAST_AGENT_SLACK_PROCESSING_DELAY_MS = 300;

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
  const sessionTitle = title?.trim() ? title : undefined;
  let processingTimer: ReturnType<typeof setTimeout> | undefined;
  let processingUpdate: Promise<void> | undefined;
  let settled = false;

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
          // Slack ignores setStatus.title after creation, so rename only when
          // its response proves an existing session still has another title.
          if (
            response.ok &&
            sessionTitle &&
            response.title !== undefined &&
            response.title !== sessionTitle
          ) {
            await slack.renameAgentSession({
              channel,
              threadTs,
              title: sessionTitle,
            });
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
      } finally {
        await slack.setAgentSessionStatus({
          channel,
          threadTs,
          status: 'active',
          ...(sessionTitle ? { title: sessionTitle } : {}),
        });
      }
    },
  };
}
