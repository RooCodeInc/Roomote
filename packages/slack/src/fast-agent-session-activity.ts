import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';
import { PRODUCT_NAME } from '@roomote/types';

import type { SlackNotifier } from './slack-notifier';

export const FAST_AGENT_SLACK_SESSION_TITLE = `${PRODUCT_NAME} Fast session`;
export const FAST_AGENT_SLACK_PROCESSING_DELAY_MS = 300;

export function createFastAgentSlackSessionActivity({
  slack,
  channel,
  threadTs,
  delayMs = FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
}: {
  slack: Pick<SlackNotifier, 'setAgentSessionStatus'>;
  channel: string;
  threadTs: string;
  delayMs?: number;
}): FastAgentTurnActivity {
  let processingTimer: ReturnType<typeof setTimeout> | undefined;
  let processingUpdate: Promise<boolean> | undefined;
  let settled = false;

  return {
    start() {
      if (processingTimer || processingUpdate || settled) return;

      processingTimer = setTimeout(() => {
        processingTimer = undefined;
        processingUpdate = slack.setAgentSessionStatus({
          channel,
          threadTs,
          status: 'processing',
          title: FAST_AGENT_SLACK_SESSION_TITLE,
        });
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
          title: FAST_AGENT_SLACK_SESSION_TITLE,
        });
      }
    },
  };
}
