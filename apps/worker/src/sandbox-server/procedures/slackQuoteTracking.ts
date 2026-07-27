import {
  getSlackThreadTsFromTaskPayload,
  normalizeTranscriptUserText,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { hasSlackThreadReplyContext } from '@roomote/slack/client';
import { getRoomoteConfig } from '../../mcp/roomote-mcp-server/config';
import {
  clearSlackReplyQuote,
  trackSlackReplyQuote,
} from '../../mcp/roomote-mcp-server/slack-api-client';

/**
 * Extract the user-visible user turn so routing and idle-session context never
 * leak into the stored Slack reply quote.
 */
function normalizeSlackQuoteText(text: string): string {
  return normalizeTranscriptUserText(text) ?? text;
}

async function getSlackQuoteTrackingConfig(params: {
  runId: number;
  logPrefix: string;
  action: 'sync' | 'clear';
  warn?: (message: string) => void;
}) {
  const { runId, logPrefix, action, warn } = params;

  const job = await sdk.taskRuns.findFirstById(runId);

  if (
    !job ||
    !hasSlackThreadReplyContext({
      payload: job.payload,
      // Thread bindings live on the task row now; the payload carries the
      // same thread context for Slack-launched and resumed jobs.
      slackThreadTs: getSlackThreadTsFromTaskPayload(job.payload) ?? null,
    })
  ) {
    return null;
  }

  const roomoteConfig = getRoomoteConfig();
  if (!roomoteConfig) {
    warn?.(
      `[${logPrefix}] Non-fatal latest user message ${action} failure for task run ${runId}: ROOMOTE_CLOUD_TOKEN/AUTH_TOKEN environment variable not set`,
    );
    return null;
  }

  return roomoteConfig;
}

export async function trackLatestUserMessageForSlackThreadQuote(params: {
  runId: number | undefined;
  text: string;
  userName: string | undefined;
  logPrefix: string;
  warn?: (message: string) => void;
}): Promise<boolean> {
  const { runId, text, userName, logPrefix, warn } = params;

  if (text.trim().length === 0 || typeof runId !== 'number') {
    return false;
  }

  try {
    const roomoteConfig = await getSlackQuoteTrackingConfig({
      runId,
      logPrefix,
      action: 'sync',
      warn,
    });
    if (!roomoteConfig) {
      return false;
    }

    await trackSlackReplyQuote(roomoteConfig, {
      runId,
      text: normalizeSlackQuoteText(text),
      userName: userName?.trim() || 'Someone',
    });
    return true;
  } catch (error) {
    warn?.(
      `[${logPrefix}] Non-fatal latest user message sync failure for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export async function clearLatestUserMessageForSlackThreadQuote(params: {
  runId: number | undefined;
  logPrefix: string;
  warn?: (message: string) => void;
}): Promise<void> {
  const { runId, logPrefix, warn } = params;

  if (typeof runId !== 'number') {
    return;
  }

  try {
    const roomoteConfig = await getSlackQuoteTrackingConfig({
      runId,
      logPrefix,
      action: 'clear',
      warn,
    });
    if (!roomoteConfig) {
      return;
    }

    await clearSlackReplyQuote(roomoteConfig, {
      runId,
    });
  } catch (error) {
    warn?.(
      `[${logPrefix}] Non-fatal latest user message clear failure for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
