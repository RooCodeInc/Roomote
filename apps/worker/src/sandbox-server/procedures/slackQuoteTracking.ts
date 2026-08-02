import { getSlackThreadTsFromTaskPayload } from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { hasSlackThreadReplyContext } from '@roomote/slack/client';
import { getRoomoteConfig } from '../../mcp/roomote-mcp-server/config';
import {
  clearSlackReplyQuote,
  trackSlackReplyQuote,
} from '../../mcp/roomote-mcp-server/slack-api-client';

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

export interface TrackedSlackReplyQuote {
  /** Present when the API is new enough to return per-quote ids. */
  quoteId?: string;
  text: string;
  userName: string;
}

export async function trackLatestUserMessageForSlackThreadQuote(params: {
  runId: number | undefined;
  text: string;
  userName: string | undefined;
  logPrefix: string;
  warn?: (message: string) => void;
}): Promise<TrackedSlackReplyQuote | null> {
  const { runId, text, userName, logPrefix, warn } = params;

  if (text.trim().length === 0 || typeof runId !== 'number') {
    return null;
  }

  try {
    const roomoteConfig = await getSlackQuoteTrackingConfig({
      runId,
      logPrefix,
      action: 'sync',
      warn,
    });
    if (!roomoteConfig) {
      return null;
    }

    const trackedUserName = userName?.trim() || 'Someone';
    const result = await trackSlackReplyQuote(roomoteConfig, {
      runId,
      text,
      userName: trackedUserName,
    });
    return {
      text,
      userName: trackedUserName,
      ...(result.quoteId ? { quoteId: result.quoteId } : {}),
    };
  } catch (error) {
    warn?.(
      `[${logPrefix}] Non-fatal latest user message sync failure for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function clearLatestUserMessageForSlackThreadQuote(params: {
  runId: number | undefined;
  trackedQuote: TrackedSlackReplyQuote;
  logPrefix: string;
  warn?: (message: string) => void;
}): Promise<void> {
  const { runId, trackedQuote, logPrefix, warn } = params;

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
      // Without an id (older API track responses), scope the clear by the
      // tracked content so it cannot drop a newer follow-up stored since.
      ...(trackedQuote.quoteId
        ? { quoteId: trackedQuote.quoteId }
        : { text: trackedQuote.text, userName: trackedQuote.userName }),
    });
  } catch (error) {
    warn?.(
      `[${logPrefix}] Non-fatal latest user message clear failure for task run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
