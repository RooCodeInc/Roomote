import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Hono } from 'hono';

import { Env } from '@roomote/env';
import {
  and,
  db,
  eq,
  findBackgroundAutomationSlackThread,
  slackInstallations,
  taskRuns,
  tasks,
  workItems,
} from '@roomote/db/server';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type SlackBlock,
} from '@roomote/types';
import {
  buildSlackThreadFooterText,
  clearLatestUserMessage,
  clearSlackThreadReplyFooterMessageTs,
  getLatestUserMessage,
  getSlackThreadReplyFooterMessageTs,
  resolveSlackThreadFooterContext,
  resolveSlackThreadLinkedPr,
  resolveSlackThreadLivePreviewUrl,
  setLatestSlackBotReply,
  setSlackThreadReplyFooterMessageTs,
  SlackNotifier,
  trackLatestUserMessageForSlackQuote,
  trackSlackBotReply,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
} from '@roomote/slack';
import {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';

import type { McpAuth } from './middleware';
import { bindLateSlackThreadToTask } from '../tasks/automation-work-items/slack.js';
import { getTaskChannelBindings } from '../tasks/helpers';
import {
  buildAutomationRootFooterBlocks,
  refreshAutomationRootFooter,
} from '../tasks/automation-slack-root-footer.js';
import {
  hasRealCloudJobUser,
  isJobTokenContext,
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
import {
  buildThreadReplyImageBlocks,
  errorResponseForThreadReplyImageError,
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE,
  withThreadReplyFooterLock,
} from './chat-reply-helpers';

type SlackMcpVariables = Variables & { mcpAuth: McpAuth };
const SLACK_THREAD_REPLY_FOOTER_BLOCK_ID = 'roomote_thread_reply_footer';
const SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX = 'slack:thread_reply_footer_lock:';
const SLACK_MAX_MESSAGE_BLOCKS = 50;
const SLACK_THREAD_REPLY_QUOTE_MAX_LENGTH = 100;
const LATE_BIND_THREAD_MAX_ATTEMPTS = 3;
const LATE_BIND_THREAD_RETRY_MS = 150;
// ~5s at the shared 100ms retry cadence; must comfortably exceed the Slack
// post + bind retries performed while the late-bind lock is held.
const LATE_BIND_LOCK_MAX_ACQUIRE_ATTEMPTS = 50;

function getFallbackText(text: string | undefined, imageCount: number): string {
  if (text) {
    return text;
  }

  return `Shared ${imageCount} image attachment${imageCount === 1 ? '' : 's'}`;
}

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
  const origin = Env.ROOMOTE_APP_URL;
  const webPath = getSlackThreadReplyWebPath(payload);
  const baseUrl = webPath ? `${origin}${webPath}` : `${origin}/task/${taskId}`;
  const url = new URL(baseUrl);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', 'slack.thread_reply');

  return url.toString();
}

function absolutizeSetupMarkdownLinks(text: string): string {
  const origin = Env.ROOMOTE_APP_URL;

  return text.replace(
    /\[([^\]]+)\]\((\/setup(?:[/?#][^)]+)?)\)/g,
    (_match, label: string, path: string) => `[${label}](${origin}${path})`,
  );
}

function absolutizeSetupMarkdownBlocks(
  blocks: unknown[] | undefined,
): unknown[] | undefined {
  if (!blocks) {
    return blocks;
  }

  return blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return block;
    }

    if (
      (block as { type?: unknown }).type !== 'markdown' ||
      typeof (block as { text?: unknown }).text !== 'string'
    ) {
      return block;
    }

    return {
      ...block,
      text: absolutizeSetupMarkdownLinks((block as { text: string }).text),
    };
  });
}

function isSetupThreadReplyPayload(payload: unknown): boolean {
  return getSlackThreadReplyWebPath(payload) === '/setup';
}

function buildSlackThreadReplyFooterBlock(params: { footerText: string }): {
  type: 'context';
  block_id: string;
  elements: [{ type: 'mrkdwn'; text: string }];
} {
  return {
    type: 'context',
    block_id: SLACK_THREAD_REPLY_FOOTER_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text: params.footerText,
      },
    ],
  };
}

async function buildLateBoundSlackRootFooterText(params: {
  taskUrl: string;
  taskId: string;
}): Promise<string> {
  // The explicit-mention marker is per-thread, so a brand-new root message
  // can never carry it; only the linked PR and live preview need resolving
  // here. PR metadata lives in taskPullRequests and is resolved by task id.
  const [linkedPr, livePreviewUrl] = await Promise.all([
    resolveSlackThreadLinkedPr({
      taskId: params.taskId,
      prRepo: null,
      prNumber: null,
    }),
    resolveSlackThreadLivePreviewUrl(params.taskId),
  ]);

  return buildSlackThreadFooterText({
    taskUrl: params.taskUrl,
    linkedPr,
    livePreviewUrl,
    explicitMentionRequired: false,
  });
}

async function buildLateBoundAutomationRootFooterBlocks(params: {
  automationWorkItemId: string;
  taskUrl: string;
  taskId: string;
}): Promise<SlackBlock[] | null> {
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

  const automationLabel =
    getTriggerableBackgroundAutomationDescriptorByKey(workItem.automationKey)
      ?.label ?? workItem.automationKey.replaceAll('_', ' ');
  const linkedPr = await resolveSlackThreadLinkedPr({
    taskId: params.taskId,
    prRepo: null,
    prNumber: null,
  });
  return buildAutomationRootFooterBlocks({
    automationLabel,
    taskUrl: params.taskUrl,
    linkedPrUrl: linkedPr?.prUrl ?? null,
  });
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

function isSlackThreadReplyFooterText(text: string): boolean {
  return /^_(?:Reply(?: with @-mention)? or use the <[^>]+\|web app>\.|Working on (?:<[^>]+\|PR(?:\s+#)?\d+>(?:, <[^>]+\|live preview>)?|a <[^>]+\|live preview>), reply(?: with @-mention)? or use the <[^>]+\|web app>\.)_$/.test(
    text,
  );
}

function isSlackThreadReplyFooterBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const record = block as {
    type?: unknown;
    block_id?: unknown;
    text?: unknown;
    elements?: unknown;
  };

  if (record.block_id === SLACK_THREAD_REPLY_FOOTER_BLOCK_ID) {
    return true;
  }

  if (
    record.type === 'markdown' &&
    typeof record.text === 'string' &&
    isSlackThreadReplyFooterText(record.text)
  ) {
    return true;
  }

  if (record.type !== 'context' || !Array.isArray(record.elements)) {
    return false;
  }

  return record.elements.some((element) => {
    if (!element || typeof element !== 'object') {
      return false;
    }

    const contextElement = element as { type?: unknown; text?: unknown };
    return (
      contextElement.type === 'mrkdwn' &&
      typeof contextElement.text === 'string' &&
      isSlackThreadReplyFooterText(contextElement.text)
    );
  });
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

async function peekSlackThreadReplyQuote(params: {
  cloudJobId: number;
}): Promise<{
  pendingUserMessage: { text: string; userName: string };
  quote: string;
} | null> {
  try {
    const latestUserMessage = await getLatestUserMessage(params.cloudJobId);

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

async function removeSlackThreadReplyFooter(params: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  messageTs: string;
}): Promise<void> {
  const blocks = await params.slack.getMessageBlocks({
    channel: params.channel,
    messageTs: params.messageTs,
    threadTs: params.threadTs,
  });

  if (!blocks) {
    return;
  }

  const updatedBlocks = blocks.filter(
    (block) => !isSlackThreadReplyFooterBlock(block),
  );

  if (updatedBlocks.length === blocks.length) {
    return;
  }

  const updated = await params.slack.updateMessage({
    channel: params.channel,
    ts: params.messageTs,
    message: { blocks: updatedBlocks },
  });

  if (!updated) {
    console.error(
      `[slackMcp#thread_reply] Failed to remove footer from prior Slack message ${params.messageTs}`,
    );
  }
}

async function withSlackThreadReplyFooterLock<T>(params: {
  channel: string;
  threadTs: string;
  maxAcquireAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  return withThreadReplyFooterLock({
    lockKey: `${SLACK_THREAD_REPLY_FOOTER_LOCK_PREFIX}${params.channel}:${params.threadTs}`,
    ...(params.maxAcquireAttempts !== undefined
      ? { maxAcquireAttempts: params.maxAcquireAttempts }
      : {}),
    fn: params.fn,
  });
}

async function refreshTrackedAutomationThreadRootFooter(params: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  taskId: string;
  taskUrl: string;
}): Promise<void> {
  // Run rows are gone; the automation-thread linkage lives on the tracked
  // Slack thread registry plus the task's own channel bindings + initiator
  // stamp (tasks.initiator_automation).
  const [trackedThread, boundTask] = await Promise.all([
    findBackgroundAutomationSlackThread({
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
  const automationLabel = trackedAutomationKey
    ? getTriggerableBackgroundAutomationDescriptorByKey(trackedAutomationKey)
        ?.label
    : null;
  const updated = await refreshAutomationRootFooter({
    slack: params.slack,
    channelId: params.channel,
    messageTs: params.threadTs,
    automationLabel: automationLabel ?? automationKey.replaceAll('_', ' '),
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

  const channelTarget = normalizeSlackChannelTarget(channel);
  if (!channelTarget) {
    throw new Error('channel is required');
  }
  if ('error' in channelTarget) {
    throw new Error(channelTarget.error);
  }

  const threadTs =
    typeof record.threadTs === 'string' && record.threadTs.trim().length > 0
      ? record.threadTs.trim()
      : undefined;

  return {
    channel: channelTarget.value,
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

function parseSlackReplyQuoteCloudJobId(body: unknown): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request body');
  }

  const cloudJobId = (body as Record<string, unknown>).cloudJobId;
  if (
    typeof cloudJobId !== 'number' ||
    !Number.isInteger(cloudJobId) ||
    cloudJobId <= 0
  ) {
    throw new Error('cloudJobId must be a positive integer');
  }

  return cloudJobId;
}

function parseTrackReplyQuoteRequestBody(body: unknown): {
  cloudJobId: number;
  text: string;
  userName: string;
} {
  const cloudJobId = parseSlackReplyQuoteCloudJobId(body);
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

  return { cloudJobId, text, userName };
}

function parseClearReplyQuoteRequestBody(body: unknown): {
  cloudJobId: number;
} {
  return {
    cloudJobId: parseSlackReplyQuoteCloudJobId(body),
  };
}

export const slackMcp = new Hono<{ Variables: SlackMcpVariables }>();

slackMcp.post('/track_reply_quote', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack reply quote tracking MCP is only available for cloud job tokens',
      },
      403,
    );
  }

  let parsedBody: { cloudJobId: number; text: string; userName: string };
  try {
    parsedBody = parseTrackReplyQuoteRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  if (parsedBody.cloudJobId !== authContext.cloudJobId) {
    return c.json(
      { error: 'cloudJobId must match the authenticated cloud job' },
      403,
    );
  }

  await trackLatestUserMessageForSlackQuote({
    cloudJobId: parsedBody.cloudJobId,
    text: parsedBody.text,
    userName: parsedBody.userName,
    onError: (error) => {
      throw error;
    },
  });

  return c.json({ success: true });
});

slackMcp.post('/clear_reply_quote', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack reply quote clearing MCP is only available for cloud job tokens',
      },
      403,
    );
  }

  let parsedBody: { cloudJobId: number };
  try {
    parsedBody = parseClearReplyQuoteRequestBody(await c.req.json());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Invalid JSON body' },
      400,
    );
  }

  if (parsedBody.cloudJobId !== authContext.cloudJobId) {
    return c.json(
      { error: 'cloudJobId must match the authenticated cloud job' },
      403,
    );
  }

  await clearLatestUserMessage(parsedBody.cloudJobId);

  return c.json({ success: true });
});

slackMcp.post('/thread_reply', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack thread reply MCP is only available for cloud job tokens',
      },
      403,
    );
  }

  const cloudJob = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      actingUserId: true,
      taskId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (!cloudJob) {
    return c.json({ error: 'Cloud job not found for this MCP token' }, 404);
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

  const communicationReply = await maybeSendCommunicationThreadReply({
    cloudJob: {
      id: cloudJob.id,
      taskId: cloudJob.taskId,
      payload: cloudJob.payload,
    },
    parsedBody,
  });

  if (communicationReply) {
    return communicationReply;
  }

  const channelBindings = await getTaskChannelBindings(cloudJob.taskId);
  const slackReplyTarget = getSlackReplyTarget({
    slackChannelId: channelBindings?.slackChannelId ?? null,
    slackThreadTs: channelBindings?.slackThreadTs ?? null,
    payload: cloudJob.payload,
  });
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
  // automation execution tasks, marked by automationWorkItemId in the payload.
  if (
    !slackReplyTarget.threadTs &&
    !getAutomationWorkItemIdFromTaskPayload(cloudJob.payload)
  ) {
    return c.json(
      {
        error:
          'Slack thread reply is only available for Slack-originated jobs with thread context',
      },
      403,
    );
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
      cloudJob: { id: cloudJob.id, taskId: cloudJob.taskId },
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
  const includeFooter = !isSetupThreadReplyPayload(cloudJob.payload);
  const taskUrl = buildSlackThreadReplyTaskUrl({
    taskId: cloudJob.taskId,
    payload: cloudJob.payload,
  });
  const automationWorkItemId = getAutomationWorkItemIdFromTaskPayload(
    cloudJob.payload,
  );
  const existingThreadTs = slackReplyTarget.threadTs;
  let messageTs: string;
  let outboundThreadTs = existingThreadTs ?? '';

  const createLateBoundRootMessage = async (): Promise<string> => {
    const lateBoundAutomationFooterBlocks =
      includeFooter && automationWorkItemId
        ? await buildLateBoundAutomationRootFooterBlocks({
            automationWorkItemId,
            taskUrl,
            taskId: cloudJob.taskId,
          })
        : null;
    const rootFooterBlocks =
      lateBoundAutomationFooterBlocks ??
      (includeFooter
        ? [
            buildSlackThreadReplyFooterBlock({
              footerText: await buildLateBoundSlackRootFooterText({
                taskUrl,
                taskId: cloudJob.taskId,
              }),
            }),
          ]
        : []);
    const trackRootFooterMessageTs =
      includeFooter && lateBoundAutomationFooterBlocks === null;
    const fallbackText =
      normalizedText ??
      (normalizedBlocks && normalizedBlocks.length > 0
        ? 'Slack reply'
        : getFallbackText(undefined, imageBlocks.length));
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

    const rootMessageTs = await slack.postMessage({
      channel: slackReplyTarget.channel,
      text: getFallbackText(fallbackText, imageBlocks.length),
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    });

    if (!rootMessageTs) {
      throw new Error('Slack chat.postMessage returned no message timestamp');
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
          taskId: cloudJob.taskId,
          channelId: slackReplyTarget.channel,
          threadTs: rootMessageTs,
          summaryText: normalizedText ?? fallbackText,
          automationWorkItemId,
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
        `[slackMcp#thread_reply] Failed to bind late-bound Slack thread ${rootMessageTs} to task ${cloudJob.taskId} after ${LATE_BIND_THREAD_MAX_ATTEMPTS} attempts; later replies may open a new thread: ${
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
          : getFallbackText(parsedBody.text, imageBlocks.length)),
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
            taskId: cloudJob.taskId,
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
        const pendingQuote =
          normalizedText && includeFooter
            ? await peekSlackThreadReplyQuote({
                cloudJobId: cloudJob.id,
              })
            : null;
        const replyFallbackText =
          normalizedText ??
          (normalizedBlocks && normalizedBlocks.length > 0
            ? 'Slack reply'
            : getFallbackText(undefined, imageBlocks.length));
        const fallbackText =
          normalizedText && pendingQuote
            ? `${pendingQuote.quote}\n${normalizedText}`
            : replyFallbackText;
        const blocks: unknown[] = [];

        if (pendingQuote) {
          blocks.push(
            buildSlackThreadReplyQuoteBlock({
              quote: pendingQuote.quote,
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

        const nextMessageTs = await slack.postMessage({
          channel: slackReplyTarget.channel,
          thread_ts: existingThreadTs,
          text: getFallbackText(fallbackText, imageBlocks.length),
          unfurl_links: false,
          unfurl_media: false,
          blocks,
        });

        if (!nextMessageTs) {
          throw new Error('Slack thread source message no longer exists');
        }

        if (pendingQuote) {
          try {
            await clearLatestUserMessage(cloudJob.id);
          } catch (error) {
            console.error(
              `[slackMcp#thread_reply] Failed to clear latest user message for cloud job ${cloudJob.id}: ${
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
                : getFallbackText(parsedBody.text, imageBlocks.length)),
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
              slack,
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
                slack,
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
            slack,
            channel: slackReplyTarget.channel,
            threadTs: existingThreadTs,
            taskId: cloudJob.taskId,
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
        threadTs: `late-bind:${cloudJob.taskId}`,
        // Root creation holds the lock through a Slack post plus bind
        // retries, so give concurrent first replies a longer acquire window
        // than ordinary footer updates before they give up.
        maxAcquireAttempts: LATE_BIND_LOCK_MAX_ACQUIRE_ATTEMPTS,
        fn: async () => {
          const reloadedBindings = await getTaskChannelBindings(
            cloudJob.taskId,
          );
          const reloadedRun = await db.query.taskRuns.findFirst({
            columns: { payload: true },
            where: eq(taskRuns.id, cloudJob.id),
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

    if (message === THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE) {
      return c.json(
        { error: 'Slack thread reply is busy; please retry shortly' },
        503,
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
  const subject = hasRealCloudJobUser(cloudJob.actingUserId)
    ? await findSlackConversationSubjectByUserId({
        userId: cloudJob.actingUserId,
        slackTeamId: slackInstallation.teamId,
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
      source: isSetupThreadReplyPayload(cloudJob.payload)
        ? 'setup_thread_reply'
        : 'task_reply',
      text: normalizedText ?? '',
      taskId: cloudJob.taskId,
      cloudJobId: cloudJob.id,
      metadata: {
        imageCount: imageBlocks.length,
      },
    });
  }

  return c.json({ messageTs });
});

slackMcp.post('/thread_lookup', async (c) => {
  const { authContext } = c.get('mcpAuth');

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack thread lookup MCP is only available for cloud job tokens',
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
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (!run) {
    return c.json({ error: 'Cloud job not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  const bindings = await getTaskChannelBindings(run.taskId);
  const cloudJob = {
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
      cloudJob,
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

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack reaction add MCP is only available for cloud job tokens',
      },
      403,
    );
  }

  const cloudJob = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (!cloudJob) {
    return c.json({ error: 'Cloud job not found for this MCP token' }, 404);
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
    cloudJob,
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
      actingSlackMembershipUserId: cloudJob.actingUserId ?? null,
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

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error:
          'Slack channel message lookup MCP is only available for cloud job tokens',
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
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (!run) {
    return c.json({ error: 'Cloud job not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
  // current-steering attribution — they legitimately diverge once a web steer
  // or follow-up switches the acting user mid-run.

  const bindings = await getTaskChannelBindings(run.taskId);
  const cloudJob = {
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
      cloudJob,
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

  if (!isJobTokenContext(authContext)) {
    return c.json(
      {
        error: 'Slack channel post MCP is only available for cloud job tokens',
      },
      403,
    );
  }

  const cloudJob = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
    },
    where: eq(taskRuns.id, authContext.cloudJobId),
  });

  if (!cloudJob) {
    return c.json({ error: 'Cloud job not found for this MCP token' }, 404);
  }

  // No principal equality check: the run-scoped token IS the authorization
  // (only this run's sandbox holds it), and this endpoint operates via the
  // deployment Slack bot token, so there is no impersonation vector. The
  // token's userId is mint-time attribution while task_runs.actingUserId is
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

  const slackInstallation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true },
    where: eq(slackInstallations.isActive, true),
  });

  if (!slackInstallation?.botAccessToken) {
    return c.json(
      { error: 'No active Slack installation found for this deployment' },
      404,
    );
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const resolvedChannelId = await slack.resolveChannelId(parsedBody.channel);
  if (!resolvedChannelId) {
    return c.json(
      { error: `Could not resolve Slack channel ${parsedBody.channel}.` },
      404,
    );
  }

  const membership = await slack.isAppInChannel(resolvedChannelId);
  if (membership === false) {
    return c.json(
      {
        error: `Slack app is not a member of channel ${parsedBody.channel}.`,
      },
      403,
    );
  }

  if (membership === null) {
    return c.json(
      {
        error: `Could not verify Slack access for channel ${parsedBody.channel}.`,
      },
      502,
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
      cloudJob: { id: cloudJob.id, taskId: cloudJob.taskId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response = errorResponseForThreadReplyImageError(message);
    if (response) {
      return response;
    }
    throw error;
  }

  const blocks: unknown[] = [];
  const normalizedText = parsedBody.text
    ? absolutizeSetupMarkdownLinks(parsedBody.text)
    : undefined;

  if (normalizedText) {
    blocks.push({
      type: 'markdown',
      text: normalizedText,
    });
  }
  blocks.push(...imageBlocks);

  const messageTs = await slack.postMessage({
    channel: resolvedChannelId,
    ...(parsedBody.threadTs && { thread_ts: parsedBody.threadTs }),
    text: getFallbackText(normalizedText, imageBlocks.length),
    unfurl_links: false,
    unfurl_media: false,
    ...(blocks.length > 0 && { blocks }),
  });

  if (!messageTs) {
    if (parsedBody.threadTs) {
      return c.json(
        { error: 'Slack thread source message no longer exists' },
        409,
      );
    }

    return c.json(
      { error: 'Slack chat.postMessage returned no message timestamp' },
      502,
    );
  }

  return c.json({ messageTs, channelId: resolvedChannelId });
});
