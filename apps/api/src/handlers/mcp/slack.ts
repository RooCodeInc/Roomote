import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Hono } from 'hono';

import { Env } from '@roomote/env';
import {
  and,
  asc,
  db,
  eq,
  findBackgroundAutomationSlackThread,
  getAutomationRuntime,
  getCustomAutomationById,
  getTaskAutomationInitiatorKey,
  slackInstallations,
  taskRuns,
  tasks,
  workItems,
} from '@roomote/db/server';
import {
  type BackgroundAutomationKey,
  getSlackTeamIdFromTaskPayload,
  getTriggerableBackgroundAutomationDescriptorByKey,
  getTriggerableBackgroundAutomationSettingsHash,
  TaskPayloadKind,
  type SlackBlock,
} from '@roomote/types';
import {
  buildAutomationResultBlocks,
  buildSlackThreadFooterText,
  buildSlackThreadReplyFooterBlock,
  clearNextSlackReplyQuoteSuppressionIfId,
  clearLatestUserMessage,
  clearSlackThreadReplyFooterMessageTs,
  getLatestUserMessage,
  getNextSlackReplyQuoteSuppression,
  getActiveSlackRunReplyTarget,
  getSlackThreadReplyFooterMessageTs,
  relocateSlackThreadActiveTaskCards,
  removeSlackThreadReplyFooter,
  resolveSlackThreadFooterContext,
  resolveSlackThreadLinkedPrs,
  resolveSlackThreadLivePreviewUrl,
  setLatestSlackBotReply,
  setSlackThreadReplyFooterMessageTs,
  SlackNotifier,
  SlackPostDeliveryError,
  suppressNextSlackReplyQuote,
  trackSlackBotReply,
  withSlackThreadReplyFooterLock,
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE as SLACK_THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
} from '@roomote/slack';
import {
  buildAutomationIconUrl,
  buildCustomAutomationSettingsUrl,
  buildManagerSlackSettingsUrl,
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
  resolveAutomationResultSubtitle,
} from '@roomote/sdk/server';
import {
  clearLatestUserMessageForReplyQuoteIfId,
  setLatestUserMessageForReplyQuote,
} from '@roomote/communication/messages';

import type { Variables } from '../../types';

import type { McpAuth } from './middleware';
import { bindLateSlackThreadToTask } from '../tasks/automation-work-items/slack.js';
import { getTaskChannelBindings } from '../tasks/helpers';
import { refreshAutomationRootFooter } from '../tasks/automation-slack-root-footer.js';
import {
  hasRealTaskRunUser,
  isRunTokenContext,
  McpProxyError,
} from './proxy-utils';
import {
  getSlackReplyTarget,
  lookupSlackChannelMessages,
  lookupSlackThread,
  normalizeSlackChannelTarget,
  resolveVerifiedSlackChannel,
} from './slack-thread-lookup';
import {
  maybeAddCommunicationReaction,
  maybeSendCommunicationThreadReply,
} from './communication-thread-replies';
import { sendCommunicationChannelPost } from './communication-channel-posts';
import {
  buildThreadReplyImageBlocks,
  errorResponseForThreadReplyImageError,
} from './chat-reply-helpers';
import {
  absolutizeSetupMarkdownBlocks,
  absolutizeSetupMarkdownLinks,
  getSlackFallbackText,
} from './slack-message-content';

type SlackMcpVariables = Variables & { mcpAuth: McpAuth };
const SLACK_MAX_MESSAGE_BLOCKS = 50;
const SLACK_THREAD_REPLY_QUOTE_MAX_LENGTH = 100;
const LATE_BIND_THREAD_MAX_ATTEMPTS = 3;
const LATE_BIND_THREAD_RETRY_MS = 150;
// ~5s at the shared 100ms retry cadence; must comfortably exceed the Slack
// post + bind retries performed while the late-bind lock is held.
const LATE_BIND_LOCK_MAX_ACQUIRE_ATTEMPTS = 50;

function getSlackThreadReplyWebPath(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const webPath = (payload as { webPath?: unknown }).webPath;

  if (typeof webPath !== 'string' || !webPath.startsWith('/')) {
    return null;
  }

  return webPath;
}

function buildSlackThreadReplyTaskUrl({
  taskId,
  payload,
}: {
  taskId: string;
  payload: unknown;
}): string {
  const origin = Env.R_APP_URL;
  const webPath = getSlackThreadReplyWebPath(payload);
  const baseUrl = webPath ? `${origin}${webPath}` : `${origin}/task/${taskId}`;
  const url = new URL(baseUrl);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', 'slack.thread_reply');

  return url.toString();
}

function isSetupThreadReplyPayload(payload: unknown): boolean {
  return getSlackThreadReplyWebPath(payload) === '/setup';
}

async function buildLateBoundSlackRootFooterText(params: {
  taskUrl: string;
  taskId: string;
}): Promise<string> {
  // The explicit-mention marker is per-thread, so a brand-new root message
  // can never carry it; only the linked PR and live preview need resolving
  // here. PR metadata lives in taskPullRequests and is resolved by task id.
  const [linkedPrs, livePreviewUrl] = await Promise.all([
    resolveSlackThreadLinkedPrs({
      taskId: params.taskId,
      prRepo: null,
      prNumber: null,
    }),
    resolveSlackThreadLivePreviewUrl(params.taskId),
  ]);

  return buildSlackThreadFooterText({
    taskUrl: params.taskUrl,
    linkedPrs,
    livePreviewUrl,
    explicitMentionRequired: false,
  });
}

type AutomationRootPresentation = {
  automationLabel: string;
  automationIconUrl: string;
  configureUrl: string;
  linkedPrUrls: string[];
  scheduleMode: string | null;
};

async function buildLateBoundAutomationRootPresentation(params: {
  automationWorkItemId: string;
  taskId: string;
}): Promise<AutomationRootPresentation | null> {
  const workItem = await db.query.workItems.findFirst({
    columns: {
      automationKey: true,
    },
    where: and(
      eq(workItems.kind, 'auto_fix'),
      eq(workItems.id, params.automationWorkItemId),
    ),
  });

  if (!workItem?.automationKey) {
    return null;
  }

  const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
    workItem.automationKey,
  );
  const settingsHash = descriptor
    ? getTriggerableBackgroundAutomationSettingsHash(descriptor.automationKey)
    : null;
  if (!descriptor || !settingsHash) return null;
  const linkedPrs = await resolveSlackThreadLinkedPrs({
    taskId: params.taskId,
    prRepo: null,
    prNumber: null,
  });
  const automationRuntime = await getAutomationRuntime(
    descriptor.automationKey,
  );
  return {
    automationLabel: descriptor.label,
    automationIconUrl: buildAutomationIconUrl(descriptor.slackIcon),
    configureUrl: buildManagerSlackSettingsUrl(settingsHash),
    linkedPrUrls: linkedPrs.map((pr) => pr.prUrl),
    scheduleMode: automationRuntime.scheduleMode,
  };
}

async function buildLateBoundCustomAutomationRootPresentation(params: {
  customAutomationId: string;
  taskId: string;
}): Promise<AutomationRootPresentation | null> {
  const automation = await getCustomAutomationById(params.customAutomationId);

  if (!automation) {
    return null;
  }

  const linkedPrs = await resolveSlackThreadLinkedPrs({
    taskId: params.taskId,
    prRepo: null,
    prNumber: null,
  });
  return {
    automationLabel: automation.name,
    automationIconUrl: buildAutomationIconUrl('zap'),
    configureUrl: buildCustomAutomationSettingsUrl(automation.id),
    linkedPrUrls: linkedPrs.map((pr) => pr.prUrl),
    scheduleMode: automation.scheduleMode,
  };
}

async function buildBackgroundAutomationRootPresentation(params: {
  automationKey: BackgroundAutomationKey;
  taskId: string;
}): Promise<AutomationRootPresentation | null> {
  const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
    params.automationKey,
  );
  if (!descriptor) return null;
  const settingsHash = getTriggerableBackgroundAutomationSettingsHash(
    descriptor.automationKey,
  );
  if (!settingsHash) return null;
  const linkedPrs = await resolveSlackThreadLinkedPrs({
    taskId: params.taskId,
    prRepo: null,
    prNumber: null,
  });
  const automationRuntime = await getAutomationRuntime(
    descriptor.automationKey,
  );
  return {
    automationLabel: descriptor.label,
    automationIconUrl: buildAutomationIconUrl(descriptor.slackIcon),
    configureUrl: buildManagerSlackSettingsUrl(settingsHash),
    linkedPrUrls: linkedPrs.map((pr) => pr.prUrl),
    scheduleMode: automationRuntime.scheduleMode,
  };
}

function getAutomationWorkItemIdFromTaskPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).automationWorkItemId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getCustomAutomationIdFromTaskPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).customAutomationId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeSlackQuoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`');
}

function truncateSlackQuoteText(text: string): string {
  if (text.length <= SLACK_THREAD_REPLY_QUOTE_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, SLACK_THREAD_REPLY_QUOTE_MAX_LENGTH).trimEnd()}...`;
}

function buildSlackThreadReplyQuote(params: {
  username: string;
  text: string;
}): string | null {
  const username = escapeSlackMrkdwnText(
    normalizeSlackQuoteText(params.username),
  );
  const text = escapeSlackMrkdwnText(
    truncateSlackQuoteText(normalizeSlackQuoteText(params.text)),
  );

  if (!username || !text) {
    return null;
  }

  return `>*${username}:* ${text}`;
}

function buildSlackThreadReplyQuoteBlock(params: { quote: string }): {
  type: 'section';
  block_id: string;
  text: { type: 'mrkdwn'; text: string };
} {
  return {
    type: 'section',
    block_id: ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
    text: {
      type: 'mrkdwn',
      text: params.quote,
    },
  };
}

async function peekSlackThreadReplyQuote(params: { runId: number }): Promise<{
  pendingUserMessage: { id: string; text: string; userName: string };
  quote: string;
} | null> {
  try {
    const latestUserMessage = await getLatestUserMessage(params.runId);

    if (!latestUserMessage || latestUserMessage.text.trim().length === 0) {
      return null;
    }

    const quote =
      buildSlackThreadReplyQuote({
        username: latestUserMessage.userName,
        text: latestUserMessage.text,
      }) ?? null;

    if (!quote) {
      return null;
    }

    return {
      pendingUserMessage: latestUserMessage,
      quote,
    };
  } catch (error) {
    console.error(
      `[slackMcp#thread_reply] Failed to build Slack reply quote: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

async function refreshTrackedAutomationThreadRootFooter(params: {
  slack: SlackNotifier;
  slackTeamId: string;
  channel: string;
  threadTs: string;
  taskId: string;
  runId: number;
  taskUrl: string;
}): Promise<void> {
  // Run rows are gone; the automation-thread linkage lives on the tracked
  // Slack thread registry plus the task's own channel bindings + initiator
  // stamp (tasks.initiator_automation).
  const [trackedThread, boundTask] = await Promise.all([
    findBackgroundAutomationSlackThread({
      surface: 'slack',
      slackTeamId: params.slackTeamId,
      slackChannelId: params.channel,
      threadTs: params.threadTs,
    }),
    db.query.tasks.findFirst({
      columns: {
        initiatorAutomation: true,
      },
      where: and(
        eq(tasks.id, params.taskId),
        eq(tasks.slackChannelId, params.channel),
        eq(tasks.slackThreadTs, params.threadTs),
      ),
    }),
  ]);

  const trackedThreadTaskId =
    typeof trackedThread?.metadata?.sourceTaskId === 'string' &&
    trackedThread.metadata.sourceTaskId.trim().length > 0
      ? trackedThread.metadata.sourceTaskId
      : null;
  const boundTaskAutomationKey = boundTask?.initiatorAutomation ?? null;

  if (trackedThreadTaskId !== params.taskId && !boundTaskAutomationKey) {
    return;
  }

  const trackedAutomationKey =
    trackedThread?.automationKey ?? boundTaskAutomationKey ?? null;
  const automationKey = trackedAutomationKey ?? 'automation';
  let automationLabel: string | null = trackedAutomationKey
    ? (getTriggerableBackgroundAutomationDescriptorByKey(trackedAutomationKey)
        ?.label ?? null)
    : null;
  let customAutomationId: string | null = null;
  let scheduleMode: string | null = null;

  // Custom automation runs have no registry descriptor, so the key would
  // render as "custom automation"; label the footer with the automation's
  // own name instead. Resume runs do not copy the marker into their
  // payloads, so scan the sibling runs (oldest first: the originating
  // launch run carries it) rather than reading one arbitrary row.
  if (!automationLabel) {
    const runs = await db
      .select({ payload: taskRuns.payload })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, params.taskId))
      .orderBy(asc(taskRuns.createdAt))
      .limit(10);
    customAutomationId =
      runs
        .map((run) => getCustomAutomationIdFromTaskPayload(run.payload))
        .find((id) => id !== null) ?? null;

    if (customAutomationId) {
      const customAutomation =
        await getCustomAutomationById(customAutomationId);
      automationLabel = customAutomation?.name ?? null;
      scheduleMode = customAutomation?.scheduleMode ?? null;
    }
  }

  const descriptor = trackedAutomationKey
    ? getTriggerableBackgroundAutomationDescriptorByKey(trackedAutomationKey)
    : null;
  const settingsHash = descriptor
    ? getTriggerableBackgroundAutomationSettingsHash(descriptor.automationKey)
    : null;
  const configureUrl = customAutomationId
    ? buildCustomAutomationSettingsUrl(customAutomationId)
    : settingsHash
      ? buildManagerSlackSettingsUrl(settingsHash)
      : buildManagerSlackSettingsUrl();
  if (!scheduleMode && descriptor) {
    scheduleMode = (await getAutomationRuntime(descriptor.automationKey))
      .scheduleMode;
  }
  const subtitle = await resolveAutomationResultSubtitle({
    taskId: params.taskId,
    runId: params.runId,
    scheduleMode,
  });

  const updated = await refreshAutomationRootFooter({
    slack: params.slack,
    channelId: params.channel,
    messageTs: params.threadTs,
    automationLabel: automationLabel ?? automationKey.replaceAll('_', ' '),
    automationIconUrl: buildAutomationIconUrl(
      customAutomationId ? 'zap' : (descriptor?.slackIcon ?? 'zap'),
    ),
    configureUrl,
    subtitle,
    taskUrl: params.taskUrl,
    taskId: params.taskId,
  });

  if (!updated) {
    console.error(
      `[slackMcp#thread_reply] Failed to refresh tracked automation root footer for thread ${params.threadTs}`,
    );
  }
}

function parseRequestBody(body: unknown): {
  text?: string;
  blocks?: unknown[];
  images: Array<{ artifactId: string }>;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const record = body as Record<string, unknown>;
  const text =
    typeof record.text === 'string' && record.text.trim().length > 0
      ? record.text.trim()
      : undefined;
  const blocks =
    record.blocks === undefined
      ? undefined
      : Array.isArray(record.blocks)
        ? record.blocks
        : null;

  if (blocks === null) {
    throw new Error('blocks must be an array');
  }

  let images: Array<{ artifactId: string }> = [];
  if (record.images !== undefined) {
    if (!Array.isArray(record.images)) {
      throw new Error('images must be an array');
    }

    images = record.images.map((image, index) => {
      if (!image || typeof image !== 'object' || Array.isArray(image)) {
        throw new Error(`images[${index}] must be an object`);
      }

      const artifactId =
        typeof image.artifactId === 'string' ? image.artifactId.trim() : '';

      if (!artifactId) {
        throw new Error(`images[${index}].artifactId is required`);
      }

      return { artifactId };
    });
  }

  if (!text && images.length === 0 && (!blocks || blocks.length === 0)) {
    throw new Error('At least one of text, blocks, or images is required');
  }

  return { text, blocks, images };
}

/**
 * Parses the channel target as-provided. Slack channel-name normalization
 * happens in the provider-specific target resolver so opaque Teams
 * conversation ids and Telegram chat ids remain untouched.
 */
function parseChannelPostRequestBody(body: unknown): {
  channel: string;
  threadTs?: string;
  text?: string;
  images: Array<{ artifactId: string }>;
} {
  const parsed = parseRequestBody(body);

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const record = body as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string' ? record.channel.trim() : '';

  if (!channel) {
    throw new Error('channel is required');
  }

  const threadTs =
    typeof record.threadTs === 'string' && record.threadTs.trim().length > 0
      ? record.threadTs.trim()
      : undefined;

  return {
    channel,
    threadTs,
    text: parsed.text,
    images: parsed.images,
  };
}

function parseThreadLookupRequestBody(body: unknown): {
  channel?: string;
  messageTs: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const record = body as Record<string, unknown>;
  const messageTs =
    typeof record.messageTs === 'string' ? record.messageTs.trim() : '';

  if (!messageTs) {
    throw new Error('messageTs is required');
  }

  const rawChannel =
    typeof record.channel === 'string' ? record.channel.trim() : '';

  if (!rawChannel) {
    return { messageTs };
  }

  const channelTarget = normalizeSlackChannelTarget(rawChannel);
  if (!channelTarget) {
    return { messageTs };
  }
  if ('error' in channelTarget) {
    throw new Error(channelTarget.error);
  }

  return { channel: channelTarget.value, messageTs };
}

function parseReactionAddRequestBody(body: unknown): {
  channel: string;
  messageTs: string;
  name: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const record = body as Record<string, unknown>;
  const rawChannel =
    typeof record.channel === 'string' ? record.channel.trim() : '';
  const messageTs =
    typeof record.messageTs === 'string' ? record.messageTs.trim() : '';
  const normalizedName =
    typeof record.name === 'string'
      ? record.name.trim().replace(/^:+|:+$/g, '')
      : '';

  if (!rawChannel) {
    throw new Error('channel is required');
  }

  const channelTarget = normalizeSlackChannelTarget(rawChannel);
  if (!channelTarget) {
    throw new Error('channel is required');
  }
  if ('error' in channelTarget) {
    throw new Error(channelTarget.error);
  }

  if (!messageTs) {
    throw new Error('messageTs is required');
  }

  if (!normalizedName || /\s/.test(normalizedName)) {
    throw new Error(
      'name must be a Slack emoji name without surrounding colons, for example eyes or white_check_mark',
    );
  }

  return {
    channel: channelTarget.value,
    messageTs,
    name: normalizedName,
  };
}

function parseChannelMessagesRequestBody(body: unknown): {
  channel?: string;
  oldest?: string;
  latest?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const record = body as Record<string, unknown>;
  const rawChannel =
    typeof record.channel === 'string' ? record.channel.trim() : '';
  const oldest =
    typeof record.oldest === 'string' && record.oldest.trim().length > 0
      ? record.oldest.trim()
      : undefined;
  const latest =
    typeof record.latest === 'string' && record.latest.trim().length > 0
      ? record.latest.trim()
      : undefined;

  if (!rawChannel) {
    return { ...(oldest ? { oldest } : {}), ...(latest ? { latest } : {}) };
  }

  const channelTarget = normalizeSlackChannelTarget(rawChannel);
  if (!channelTarget) {
    return { ...(oldest ? { oldest } : {}), ...(latest ? { latest } : {}) };
  }
  if ('error' in channelTarget) {
    throw new Error(channelTarget.error);
  }

  return {
    channel: channelTarget.value,
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
  };
}

function parseSlackReplyQuoteRunId(body: unknown): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const runId = (body as Record<string, unknown>).runId;
  if (typeof runId !== 'number' || !Number.isInteger(runId) || runId <= 0) {
    throw new Error('runId must be a positive integer');
  }

  return runId;
}

function parseTrackReplyQuoteRequestBody(body: unknown): {
  runId: number;
  text: string;
  userName: string;
} {
  const runId = parseSlackReplyQuoteRunId(body);
  const record = body as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const userName =
    typeof record.userName === 'string' ? record.userName.trim() : '';

  if (!text) {
    throw new Error('text is required');
  }

  if (!userName) {
    throw new Error('userName is required');
  }

  return { runId, text, userName };
}

function parseClearReplyQuoteRequestBody(body: unknown): {
  runId: number;
  quoteId?: string;
} {
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const quoteId =
    record && typeof record.quoteId === 'string' ? record.quoteId.trim() : '';
  return {
    runId: parseSlackReplyQuoteRunId(body),
    ...(quoteId ? { quoteId } : {}),
  };
}

export const slackMcp = new Hono<{ Variables: SlackMcpVariables }>();

slackMcp.post('/track_reply_quote', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack reply quote tracking MCP is only available for task run tokens',
      },
      403,
    );
  }

  let parsedBody: { runId: number; text: string; userName: string };
  try {
    parsedBody = parseTrackReplyQuoteRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  if (parsedBody.runId !== authContext.runId) {
    return c.json(
      { error: 'runId must match the authenticated task run' },
      403,
    );
  }

  const quote = await setLatestUserMessageForReplyQuote(
    'slack',
    parsedBody.runId,
    {
      text: parsedBody.text,
      userName: parsedBody.userName,
    },
  );

  return c.json({ success: true, quoteId: quote.id });
});

slackMcp.post('/suppress_reply_quote', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack reply quote suppression MCP is only available for task run tokens',
      },
      403,
    );
  }

  let runId: number;
  try {
    runId = parseSlackReplyQuoteRunId(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  if (runId !== authContext.runId) {
    return c.json(
      { error: 'runId must match the authenticated task run' },
      403,
    );
  }

  const quoteId = await suppressNextSlackReplyQuote(runId);
  return c.json({ success: true, quoteId });
});

slackMcp.post('/clear_reply_quote', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack reply quote clearing MCP is only available for task run tokens',
      },
      403,
    );
  }

  let parsedBody: { runId: number; quoteId?: string };
  try {
    parsedBody = parseClearReplyQuoteRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  if (parsedBody.runId !== authContext.runId) {
    return c.json(
      { error: 'runId must match the authenticated task run' },
      403,
    );
  }

  if (parsedBody.quoteId) {
    await Promise.all([
      clearLatestUserMessageForReplyQuoteIfId(
        'slack',
        parsedBody.runId,
        parsedBody.quoteId,
      ),
      clearNextSlackReplyQuoteSuppressionIfId(
        parsedBody.runId,
        parsedBody.quoteId,
      ),
    ]);
  } else {
    // Bare runId requests come from previous-release workers whose clear
    // contract has always been run-scoped.
    await clearLatestUserMessage(parsedBody.runId);
  }

  return c.json({ success: true });
});

async function findSlackNotifierForLateBoundChannel(
  channelId: string,
): Promise<
  | { status: 'resolved'; slack: SlackNotifier; teamId: string }
  | { status: 'unresolved' }
  | { status: 'indeterminate' }
> {
  const installations = await db.query.slackInstallations.findMany({
    columns: { botAccessToken: true, teamId: true },
    where: eq(slackInstallations.isActive, true),
  });
  const candidates = await Promise.all(
    installations.map(async (installation) => {
      const slack = new SlackNotifier(installation.botAccessToken);
      return {
        membership: await slack.isAppInChannel(channelId),
        slack,
        teamId: installation.teamId,
      };
    }),
  );
  if (candidates.some((candidate) => candidate.membership === null)) {
    return { status: 'indeterminate' };
  }

  const matchingInstallations = candidates.filter(
    (candidate) => candidate.membership === true,
  );

  return matchingInstallations.length === 1
    ? { status: 'resolved', ...matchingInstallations[0]! }
    : { status: 'unresolved' };
}

slackMcp.post('/thread_reply', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack thread reply MCP is only available for task run tokens',
      },
      403,
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      actingUserId: true,
      taskId: true,
      payload: true,
      payloadKind: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and replies go out via the deployment
  // Slack bot token, so there is no impersonation vector. The token's userId
  // is mint-time attribution while task_runs.actingUserId is current-steering
  // attribution — they legitimately diverge once a web steer or follow-up
  // switches the acting user mid-run.

  let parsedBody: {
    text?: string;
    blocks?: unknown[];
    images: Array<{ artifactId: string }>;
  };
  try {
    parsedBody = parseRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  const activeSlackReplyTarget = await getActiveSlackRunReplyTarget(taskRun.id);
  const resumeSlackReplyTarget =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume
      ? getSlackReplyTarget(
          {
            slackChannelId: null,
            slackThreadTs: null,
            payload: taskRun.payload,
          },
          { preferPayload: true },
        )
      : null;
  const communicationReply =
    activeSlackReplyTarget || resumeSlackReplyTarget
      ? null
      : await maybeSendCommunicationThreadReply({
          taskRun: {
            id: taskRun.id,
            taskId: taskRun.taskId,
            payload: taskRun.payload,
          },
          parsedBody,
        });

  if (communicationReply) {
    return communicationReply;
  }

  const channelBindings = await getTaskChannelBindings(taskRun.taskId);
  const slackReplyTarget = activeSlackReplyTarget
    ? {
        channel: activeSlackReplyTarget.channel,
        threadTs: activeSlackReplyTarget.threadTs,
      }
    : getSlackReplyTarget(
        {
          slackChannelId: channelBindings?.slackChannelId ?? null,
          slackThreadTs: channelBindings?.slackThreadTs ?? null,
          payload: taskRun.payload,
        },
        {
          preferPayload: taskRun.payloadKind === TaskPayloadKind.SnapshotResume,
        },
      );
  if (!slackReplyTarget) {
    return c.json(
      {
        error:
          'Slack thread reply is only available for jobs with Slack channel context',
      },
      403,
    );
  }

  // Creating a brand-new top-level channel message is reserved for late-bound
  // automation tasks: execution tasks marked by automationWorkItemId, custom
  // automation runs marked by customAutomationId in the payload, and any task
  // an automation launched.
  const backgroundAutomationKey = await getTaskAutomationInitiatorKey(
    taskRun.taskId,
  );

  if (
    !slackReplyTarget.threadTs &&
    !getAutomationWorkItemIdFromTaskPayload(taskRun.payload) &&
    !getCustomAutomationIdFromTaskPayload(taskRun.payload) &&
    !backgroundAutomationKey
  ) {
    return c.json(
      {
        error:
          'Slack thread reply is only available for Slack-originated jobs with thread context',
      },
      403,
    );
  }

  const slackTeamId =
    activeSlackReplyTarget?.slackTeamId ??
    getSlackTeamIdFromTaskPayload(taskRun.payload);
  const needsLateBoundSlackResolution =
    !slackTeamId && !slackReplyTarget.threadTs;
  const lateBoundSlackResolution = needsLateBoundSlackResolution
    ? await findSlackNotifierForLateBoundChannel(slackReplyTarget.channel)
    : null;
  if (lateBoundSlackResolution?.status === 'indeterminate') {
    return c.json(
      {
        error: 'Slack report destination could not be verified; retry shortly',
        retryable: true,
      },
      503,
    );
  }
  const lateBoundSlack =
    lateBoundSlackResolution?.status === 'resolved'
      ? lateBoundSlackResolution
      : null;
  const slackInstallation = needsLateBoundSlackResolution
    ? null
    : await db.query.slackInstallations.findFirst({
        columns: { botAccessToken: true, teamId: true },
        where: slackTeamId
          ? and(
              eq(slackInstallations.isActive, true),
              eq(slackInstallations.teamId, slackTeamId),
            )
          : eq(slackInstallations.isActive, true),
      });
  const resolvedSlack =
    lateBoundSlack?.slack ??
    (slackInstallation?.botAccessToken
      ? new SlackNotifier(slackInstallation.botAccessToken)
      : null);
  const resolvedSlackTeamId =
    lateBoundSlack?.teamId ?? slackInstallation?.teamId ?? null;

  if (!resolvedSlack || !resolvedSlackTeamId) {
    return c.json(
      {
        error: needsLateBoundSlackResolution
          ? 'Slack report destination could not be resolved to one active installation'
          : 'No active Slack installation found for this deployment',
      },
      404,
    );
  }

  const artifactIds = [
    ...new Set(parsedBody.images.map((image) => image.artifactId)),
  ];
  let imageBlocks: Array<{
    type: 'image';
    image_url: string;
    alt_text: string;
  }>;
  try {
    imageBlocks = await buildThreadReplyImageBlocks({
      artifactIds,
      taskRun: { id: taskRun.id, taskId: taskRun.taskId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response = errorResponseForThreadReplyImageError(message);
    if (response) {
      return response;
    }
    throw error;
  }

  const normalizedText = parsedBody.text
    ? absolutizeSetupMarkdownLinks(parsedBody.text)
    : undefined;
  const normalizedBlocks = absolutizeSetupMarkdownBlocks(parsedBody.blocks);
  const includeFooter = !isSetupThreadReplyPayload(taskRun.payload);
  const taskUrl = buildSlackThreadReplyTaskUrl({
    taskId: taskRun.taskId,
    payload: taskRun.payload,
  });
  const automationWorkItemId = getAutomationWorkItemIdFromTaskPayload(
    taskRun.payload,
  );
  const customAutomationId = getCustomAutomationIdFromTaskPayload(
    taskRun.payload,
  );
  const existingThreadTs = slackReplyTarget.threadTs;
  let messageTs: string;
  let outboundThreadTs = existingThreadTs ?? '';

  const createLateBoundRootMessage = async (): Promise<string> => {
    const automationPresentation =
      includeFooter && automationWorkItemId
        ? await buildLateBoundAutomationRootPresentation({
            automationWorkItemId,
            taskId: taskRun.taskId,
          })
        : includeFooter && customAutomationId
          ? await buildLateBoundCustomAutomationRootPresentation({
              customAutomationId,
              taskId: taskRun.taskId,
            })
          : includeFooter && backgroundAutomationKey
            ? await buildBackgroundAutomationRootPresentation({
                automationKey: backgroundAutomationKey,
                taskId: taskRun.taskId,
              })
            : null;
    const automationSubtitle = automationPresentation
      ? await resolveAutomationResultSubtitle({
          taskId: taskRun.taskId,
          runId: taskRun.id,
          scheduleMode: automationPresentation.scheduleMode,
        })
      : undefined;
    const rootFooterBlocks =
      automationPresentation || !includeFooter
        ? []
        : [
            buildSlackThreadReplyFooterBlock({
              footerText: await buildLateBoundSlackRootFooterText({
                taskUrl,
                taskId: taskRun.taskId,
              }),
            }),
          ];
    const trackRootFooterMessageTs =
      includeFooter && automationPresentation === null;
    const fallbackText =
      normalizedText ??
      (normalizedBlocks && normalizedBlocks.length > 0
        ? 'Slack reply'
        : getSlackFallbackText(undefined, imageBlocks.length));
    const blocks: unknown[] = [];
    const maxReplyBlocks = Math.max(
      0,
      SLACK_MAX_MESSAGE_BLOCKS - imageBlocks.length - rootFooterBlocks.length,
    );

    if (normalizedText) {
      if (normalizedBlocks && normalizedBlocks.length > 0) {
        blocks.push(...normalizedBlocks.slice(0, maxReplyBlocks));
      } else if (maxReplyBlocks > 0) {
        blocks.push({
          type: 'markdown',
          text: normalizedText,
        });
      }
    } else if (normalizedBlocks && normalizedBlocks.length > 0) {
      blocks.push(...normalizedBlocks.slice(0, maxReplyBlocks));
    }
    blocks.push(...imageBlocks);
    blocks.push(...rootFooterBlocks);
    const outboundBlocks = automationPresentation
      ? buildAutomationResultBlocks({
          title: automationPresentation.automationLabel,
          iconUrl: automationPresentation.automationIconUrl,
          configureUrl: automationPresentation.configureUrl,
          subtitle: automationSubtitle,
          contentBlocks: blocks as SlackBlock[],
          taskUrl,
          linkedPrUrls: automationPresentation.linkedPrUrls,
        })
      : blocks;

    const rootPostResult = await resolvedSlack.postMessageDetailed({
      channel: slackReplyTarget.channel,
      text: getSlackFallbackText(fallbackText, imageBlocks.length),
      unfurl_links: false,
      unfurl_media: false,
      blocks: outboundBlocks,
    });
    const rootMessageTs = rootPostResult.ts;

    if (!rootMessageTs) {
      throw new SlackPostDeliveryError(rootPostResult);
    }

    // The root message is already visible in Slack; failing the reply here
    // would make the agent re-post a duplicate root, so retry the bind a few
    // times and otherwise log and continue.
    let bindError: unknown = null;
    for (
      let attempt = 1;
      attempt <= LATE_BIND_THREAD_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await bindLateSlackThreadToTask({
          taskId: taskRun.taskId,
          channelId: slackReplyTarget.channel,
          threadTs: rootMessageTs,
          summaryText: normalizedText ?? fallbackText,
          automationWorkItemId,
          backgroundAutomationKey,
        });
        bindError = null;
        break;
      } catch (error) {
        bindError = error;
        if (attempt < LATE_BIND_THREAD_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, LATE_BIND_THREAD_RETRY_MS * attempt),
          );
        }
      }
    }
    if (bindError) {
      console.error(
        `[slackMcp#thread_reply] Failed to bind late-bound Slack thread ${rootMessageTs} to task ${taskRun.taskId} after ${LATE_BIND_THREAD_MAX_ATTEMPTS} attempts; later replies may open a new thread: ${
          bindError instanceof Error ? bindError.message : String(bindError)
        }`,
      );
    }

    if (trackRootFooterMessageTs) {
      await setSlackThreadReplyFooterMessageTs(
        slackReplyTarget.channel,
        rootMessageTs,
        rootMessageTs,
      ).catch((error) => {
        console.error(
          `[slackMcp#thread_reply] Failed to persist late-bound footer message ts ${rootMessageTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    await trackSlackBotReply(
      slackReplyTarget.channel,
      rootMessageTs,
      rootMessageTs,
    ).catch((error) => {
      console.error(
        `[slackMcp#thread_reply] Failed to track late-bound Slack bot reply ${rootMessageTs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await setLatestSlackBotReply(
      slackReplyTarget.channel,
      rootMessageTs,
      rootMessageTs,
      parsedBody.text ??
        (normalizedBlocks && normalizedBlocks.length > 0
          ? 'Slack reply'
          : getSlackFallbackText(parsedBody.text, imageBlocks.length)),
    ).catch((error) => {
      console.error(
        `[slackMcp#thread_reply] Failed to persist late-bound Slack bot reply ${rootMessageTs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return rootMessageTs;
  };

  const postReplyToExistingThread = async (
    existingThreadTs: string,
  ): Promise<string> => {
    const footerText = includeFooter
      ? buildSlackThreadFooterText({
          taskUrl,
          ...(await resolveSlackThreadFooterContext({
            taskId: taskRun.taskId,
            prRepo: null,
            prNumber: null,
            channelId: slackReplyTarget.channel,
            threadTs: existingThreadTs,
          })),
        })
      : null;

    return withSlackThreadReplyFooterLock({
      channel: slackReplyTarget.channel,
      threadTs: existingThreadTs,
      fn: async () => {
        const previousFooterMessageTs =
          await getSlackThreadReplyFooterMessageTs(
            slackReplyTarget.channel,
            existingThreadTs,
          );
        const [pendingQuote, replyQuoteSuppressionId] = await Promise.all([
          peekSlackThreadReplyQuote({ runId: taskRun.id }),
          getNextSlackReplyQuoteSuppression(taskRun.id),
        ]);
        const renderedQuote = replyQuoteSuppressionId ? null : pendingQuote;
        const replyFallbackText =
          normalizedText ??
          (normalizedBlocks && normalizedBlocks.length > 0
            ? 'Slack reply'
            : getSlackFallbackText(undefined, imageBlocks.length));
        const fallbackText =
          normalizedText && renderedQuote
            ? `${renderedQuote.quote}\n${normalizedText}`
            : replyFallbackText;
        const blocks: unknown[] = [];

        if (normalizedText && renderedQuote) {
          blocks.push(
            buildSlackThreadReplyQuoteBlock({
              quote: renderedQuote.quote,
            }),
          );
        }

        const maxReplyBlocks = Math.max(
          0,
          SLACK_MAX_MESSAGE_BLOCKS -
            blocks.length -
            imageBlocks.length -
            (includeFooter ? 1 : 0),
        );

        if (normalizedText) {
          if (normalizedBlocks && normalizedBlocks.length > 0) {
            blocks.push(...normalizedBlocks.slice(0, maxReplyBlocks));
          } else if (maxReplyBlocks > 0) {
            blocks.push({
              type: 'markdown',
              text: normalizedText,
            });
          }
        } else if (normalizedBlocks && normalizedBlocks.length > 0) {
          blocks.push(...normalizedBlocks.slice(0, maxReplyBlocks));
        }
        blocks.push(...imageBlocks);
        if (footerText) {
          blocks.push(
            buildSlackThreadReplyFooterBlock({
              footerText,
            }),
          );
        }

        if (includeFooter) {
          try {
            await relocateSlackThreadActiveTaskCards({
              slack: resolvedSlack,
              channel: slackReplyTarget.channel,
              threadTs: existingThreadTs,
            });
          } catch (error) {
            console.warn(
              `[slackMcp#thread_reply] Failed to relocate active task cards before posting the reply: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        const replyPostResult = await resolvedSlack.postMessageDetailed({
          channel: slackReplyTarget.channel,
          thread_ts: existingThreadTs,
          text: getSlackFallbackText(fallbackText, imageBlocks.length),
          unfurl_links: false,
          unfurl_media: false,
          blocks,
        });
        const nextMessageTs = replyPostResult.ts;

        if (!nextMessageTs) {
          if (replyPostResult.skippedMissingThreadRoot) {
            throw new Error('Slack thread source message no longer exists');
          }
          throw new SlackPostDeliveryError(replyPostResult);
        }

        if (pendingQuote) {
          try {
            await clearLatestUserMessageForReplyQuoteIfId(
              'slack',
              taskRun.id,
              pendingQuote.pendingUserMessage.id,
            );
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to clear latest user message for task run ${taskRun.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (replyQuoteSuppressionId) {
          try {
            await clearNextSlackReplyQuoteSuppressionIfId(
              taskRun.id,
              replyQuoteSuppressionId,
            );
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to clear reply quote suppression for task run ${taskRun.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        try {
          await trackSlackBotReply(
            slackReplyTarget.channel,
            existingThreadTs,
            nextMessageTs,
          );
        } catch (error) {
          console.error(
            `[slackMcp#thread_reply] Failed to track Slack bot reply ${nextMessageTs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        try {
          await setLatestSlackBotReply(
            slackReplyTarget.channel,
            existingThreadTs,
            nextMessageTs,
            parsedBody.text ??
              (normalizedBlocks && normalizedBlocks.length > 0
                ? 'Slack reply'
                : getSlackFallbackText(parsedBody.text, imageBlocks.length)),
          );
        } catch (error) {
          console.error(
            `[slackMcp#thread_reply] Failed to persist latest Slack bot reply ${nextMessageTs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (
          previousFooterMessageTs &&
          previousFooterMessageTs !== nextMessageTs
        ) {
          try {
            await removeSlackThreadReplyFooter({
              slack: resolvedSlack,
              channel: slackReplyTarget.channel,
              threadTs: existingThreadTs,
              messageTs: previousFooterMessageTs,
            });
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to remove footer from prior Slack message ${previousFooterMessageTs}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (includeFooter) {
          try {
            await setSlackThreadReplyFooterMessageTs(
              slackReplyTarget.channel,
              existingThreadTs,
              nextMessageTs,
            );
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to persist latest footer message ts ${nextMessageTs}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            try {
              await removeSlackThreadReplyFooter({
                slack: resolvedSlack,
                channel: slackReplyTarget.channel,
                threadTs: existingThreadTs,
                messageTs: nextMessageTs,
              });
            } catch (removeError) {
              console.error(
                `[slackMcp#thread_reply] Failed to remove footer from latest Slack message ${nextMessageTs} after persistence failure: ${
                  removeError instanceof Error
                    ? removeError.message
                    : String(removeError)
                }`,
              );
            }
          }
        } else {
          try {
            await clearSlackThreadReplyFooterMessageTs(
              slackReplyTarget.channel,
              existingThreadTs,
            );
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to clear tracked footer message ts for setup thread: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        try {
          await refreshTrackedAutomationThreadRootFooter({
            slack: resolvedSlack,
            slackTeamId: resolvedSlackTeamId,
            channel: slackReplyTarget.channel,
            threadTs: existingThreadTs,
            taskId: taskRun.taskId,
            runId: taskRun.id,
            taskUrl,
          });
        } catch (error) {
          console.error(
            `[slackMcp#thread_reply] Failed to refresh tracked automation root footer for thread ${existingThreadTs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        return nextMessageTs;
      },
    });
  };

  try {
    if (!existingThreadTs) {
      // Serialize root creation per task and re-check the job inside the
      // lock so concurrent or retried replies reuse an already-bound thread
      // instead of posting a second top-level root message.
      const lateBound = await withSlackThreadReplyFooterLock({
        channel: slackReplyTarget.channel,
        threadTs: `late-bind:${taskRun.taskId}`,
        // Root creation holds the lock through a Slack post plus bind
        // retries, so give concurrent first replies a longer acquire window
        // than ordinary footer updates before they give up.
        maxAcquireAttempts: LATE_BIND_LOCK_MAX_ACQUIRE_ATTEMPTS,
        fn: async () => {
          const reloadedBindings = await getTaskChannelBindings(taskRun.taskId);
          const reloadedRun = await db.query.taskRuns.findFirst({
            columns: { payload: true },
            where: eq(taskRuns.id, taskRun.id),
          });
          const alreadyBoundThreadTs = reloadedRun
            ? (getSlackReplyTarget({
                slackChannelId: reloadedBindings?.slackChannelId ?? null,
                slackThreadTs: reloadedBindings?.slackThreadTs ?? null,
                payload: reloadedRun.payload,
              })?.threadTs ?? null)
            : null;

          if (alreadyBoundThreadTs) {
            return {
              messageTs: await postReplyToExistingThread(alreadyBoundThreadTs),
              threadTs: alreadyBoundThreadTs,
            };
          }

          const rootMessageTs = await createLateBoundRootMessage();

          return { messageTs: rootMessageTs, threadTs: rootMessageTs };
        },
      });

      messageTs = lateBound.messageTs;
      outboundThreadTs = lateBound.threadTs;
    } else {
      outboundThreadTs = existingThreadTs;
      messageTs = await postReplyToExistingThread(existingThreadTs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === SLACK_THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE) {
      return c.json(
        { error: 'Slack thread reply is busy; please retry shortly' },
        503,
      );
    }

    if (error instanceof SlackPostDeliveryError) {
      return c.json(
        {
          error: error.message,
          slackErrorCode: error.slackErrorCode ?? null,
          retryable: error.retryable,
        },
        error.retryable ? 502 : 422,
      );
    }

    if (message === 'Slack chat.postMessage returned no message timestamp') {
      return c.json(
        { error: 'Slack chat.postMessage returned no message timestamp' },
        502,
      );
    }

    if (message === 'Slack thread source message no longer exists') {
      return c.json({ error: message }, 409);
    }

    throw error;
  }

  // Conversation-subject bookkeeping is keyed to a human user; skip it for
  // deployment-service-principal runs, which have no acting user.
  const subject = hasRealTaskRunUser(taskRun.actingUserId)
    ? await findSlackConversationSubjectByUserId({
        userId: taskRun.actingUserId,
        slackTeamId: resolvedSlackTeamId,
      })
    : null;

  if (subject) {
    await recordSlackConversationMessageBestEffort({
      logContext: 'slackMcp.thread_reply',
      ...subject,
      senderSlackUserId: null,
      slackChannelId: slackReplyTarget.channel,
      conversationKind: 'thread',
      threadTs: outboundThreadTs,
      messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: isSetupThreadReplyPayload(taskRun.payload)
        ? 'setup_thread_reply'
        : 'task_reply',
      text: normalizedText ?? '',
      taskId: taskRun.taskId,
      runId: taskRun.id,
      metadata: {
        imageCount: imageBlocks.length,
      },
    });
  }

  return c.json({ messageTs });
});

slackMcp.post('/thread_lookup', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack thread lookup MCP is only available for task run tokens',
      },
      403,
    );
  }

  const run = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!run) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  const bindings = await getTaskChannelBindings(run.taskId);
  const taskRun = {
    slackChannelId: bindings?.slackChannelId ?? null,
    slackThreadTs: bindings?.slackThreadTs ?? null,
    payload: run.payload,
    actingUserId: run.actingUserId,
  };

  let parsedBody: { channel?: string; messageTs: string };
  try {
    parsedBody = parseThreadLookupRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    const payload = await lookupSlackThread({
      messageTs: parsedBody.messageTs,
      ...(typeof parsedBody.channel === 'string'
        ? { channel: parsedBody.channel }
        : {}),
      taskRun,
    });

    return c.json(payload);
  } catch (error) {
    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }

    throw error;
  }
});

slackMcp.post('/reaction_add', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack reaction add MCP is only available for task run tokens',
      },
      403,
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  let parsedBody: {
    channel: string;
    messageTs: string;
    name: string;
  };
  try {
    parsedBody = parseReactionAddRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  const communicationReaction = await maybeAddCommunicationReaction({
    taskRun,
    parsedBody,
  });

  if (communicationReaction) {
    return communicationReaction;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true, teamId: true },
    where: eq(slackInstallations.isActive, true),
  });

  if (!slackInstallation?.botAccessToken) {
    return c.json(
      { error: 'No active Slack installation found for this deployment' },
      404,
    );
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  let resolvedChannelId: string;
  try {
    resolvedChannelId = await resolveVerifiedSlackChannel({
      channel: parsedBody.channel,
      slack,
      slackTeamId: slackInstallation.teamId,
      actingSlackMembershipUserId: taskRun.actingUserId ?? null,
    });
  } catch (error) {
    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }

    throw error;
  }

  const added = await slack.addReaction({
    channel: resolvedChannelId,
    timestamp: parsedBody.messageTs,
    name: parsedBody.name,
  });

  if (!added) {
    return c.json(
      {
        error: `Slack reactions.add failed for channel ${resolvedChannelId} at ${parsedBody.messageTs}.`,
      },
      502,
    );
  }

  return c.json({
    channelId: resolvedChannelId,
    messageTs: parsedBody.messageTs,
    name: parsedBody.name,
  });
});

slackMcp.post('/channel_messages', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack channel message lookup MCP is only available for task run tokens',
      },
      403,
    );
  }

  const run = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!run) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  const bindings = await getTaskChannelBindings(run.taskId);
  const taskRun = {
    slackChannelId: bindings?.slackChannelId ?? null,
    slackThreadTs: bindings?.slackThreadTs ?? null,
    payload: run.payload,
    actingUserId: run.actingUserId,
  };

  let parsedBody: {
    channel?: string;
    oldest?: string;
    latest?: string;
  };
  try {
    parsedBody = parseChannelMessagesRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  try {
    const payload = await lookupSlackChannelMessages({
      ...(typeof parsedBody.channel === 'string'
        ? { channel: parsedBody.channel }
        : {}),
      ...(typeof parsedBody.oldest === 'string'
        ? { oldest: parsedBody.oldest }
        : {}),
      ...(typeof parsedBody.latest === 'string'
        ? { latest: parsedBody.latest }
        : {}),
      taskRun,
    });

    return c.json(payload);
  } catch (error) {
    if (error instanceof McpProxyError) {
      return c.json(
        { error: error.message },
        { status: error.httpStatus as ContentfulStatusCode },
      );
    }

    throw error;
  }
});

slackMcp.post('/channel_post', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isRunTokenContext(authContext)) {
    return c.json(
      {
        error: 'Channel post MCP is only available for task run tokens',
      },
      403,
    );
  }

  const taskRun = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      payload: true,
      actingUserId: true,
    },
    where: eq(taskRuns.id, authContext.runId),
  });

  if (!taskRun) {
    return c.json({ error: 'Task run not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment communication credentials, so there is no impersonation
  // vector. The token's userId is mint-time attribution while
  // task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  let parsedBody: {
    channel: string;
    threadTs?: string;
    text?: string;
    images: Array<{ artifactId: string }>;
  };
  try {
    parsedBody = parseChannelPostRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  return sendCommunicationChannelPost({
    taskRun,
    parsedBody,
  });
});
