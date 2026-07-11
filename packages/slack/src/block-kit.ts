import { randomUUID } from 'node:crypto';

import {
  type SlackBlock,
  AGENT_DISPLAY_NAME,
  type TaskPayload,
  TaskPayloadKind,
  ALL_REPOSITORIES,
  PRODUCT_NAME,
  buildSlackThreadPermalink,
  getHarnessModelOverride,
  getSlackConversationUrlFromTaskPayload,
  getSlackTeamDomainFromTaskPayload,
  getTaskModelDisplayName,
} from '@roomote/types';
import { Env } from '@roomote/env';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import {
  buildAccountLinkConnectCopy,
  buildAccountLinkThreadReplyText as buildSharedAccountLinkThreadReplyText,
  buildRoutingConfirmationText,
} from '@roomote/communication/chat-messages';
import {
  type SlackInstallation,
  type SlackUserMapping,
  db,
  tasks,
  taskRuns,
  slackInstallations,
  slackUserMappings,
  slackAuthTokens,
  repositories,
  environments,
  eq,
  and,
} from '@roomote/db/server';
import {
  appendAttachmentTextsToPromptText,
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';
import { getDefaultDocsUrl } from '@roomote/env';
import {
  type RoutingDebugInfo,
  type RoutingResult,
  type RoutingWorkspace,
  type SlackMcpSetupRequirement,
  detectSlackMcpSetupRequirement,
  routeTask,
  classifyFollowUp,
  buildSlackRoutingContext,
} from '@roomote/cloud-agents/server';

import type {
  SlackEvent,
  SlackInteractivePayload,
  SlackMessage,
  SlackThreadMessage,
} from './types';
import { postRouterDebugMessage } from './router-debug';
import { postSlackInteractiveResponse } from './interactive-response';
import { getPromptReadyThreadMessages } from './prompt-ready-thread-messages';
import { SlackNotifier } from './slack-notifier';
import { setSlackStartedMessageTs } from './slack-messages';
import { startSlackAppMentionTask } from './start-slack-app-mention';
import { SlackThreadDeliveryTracker } from './slack-thread-delivery-tracker';
import {
  buildStartedBlocks,
  buildTaskFailedMessage,
  buildTaskFailedBlocks,
  SLACK_RUNTIME_FAILURE_TEXT,
  SLACK_STARTUP_FAILURE_TEXT,
} from './started-message-blocks';
import { appendSlackVideoDescriptionsToText } from './video-descriptions';
import { maybeNotifyManagerChannelForMcpSetupRequirement } from './manager-mcp-setup';
import {
  finishRoutedStart,
  getSlackStartedMessageFollowUrl,
} from './started-message';

/**
 * Prefixes to distinguish between environment and repository selections.
 */
const ENV_PREFIX = 'env:';
const REPO_PREFIX = 'repo:';

/**
 * Maximum number of options to display as radio buttons.
 * Above this threshold, we use a select dropdown instead.
 */
const MAX_RADIO_BUTTON_OPTIONS = 10;

/**
 * Maximum character length for text fields in Slack Block Kit options.
 */
const MAX_TEXT_LENGTH = 75;

/**
 * Redis key prefix for storing LLM routing pre-fill data for auto-confirm.
 */
const ROUTING_PREFILL_PREFIX = 'routing_prefill:';
const MCP_SETUP_INTERRUPT_PREFIX = 'slack:mcp-setup-interrupt:';
const MCP_SETUP_INTERRUPT_TTL_SECONDS = 15 * 60;
const SLACK_AUTH_NO_RESUME_SENTINEL = '__roomote:no-resume__';

function formatSlackCode(value: string): string {
  return `\`${value}\``;
}

export function shouldResumeSlackAuthThread(originalText: string): boolean {
  return originalText !== SLACK_AUTH_NO_RESUME_SENTINEL;
}

export interface SlackAccountLinkPromptResult {
  dmPromptSent: boolean;
}

export function buildSlackAccountLinkConnectMessage(
  authToken: string,
): SlackMessage {
  const copy = buildAccountLinkConnectCopy({
    providerName: 'Slack',
    productName: PRODUCT_NAME,
  });

  return {
    text: `👋 ${copy.fallbackText}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: copy.introText,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${copy.requirementText}*\n\nThis links your identity so I can:\n${copy.identityBenefits
            .map((benefit) => `• ${benefit}`)
            .join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'connect_account',
            text: {
              type: 'plain_text',
              text: copy.buttonText,
              emoji: true,
            },
            url: `${Env.SLACK_AUTH_URI}?state=${authToken}`,
            style: 'primary',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: copy.contextText,
          },
        ],
      },
    ],
  };
}

function isSlackDirectMessageChannel(
  channel: string,
  channelType?: string,
): boolean {
  return channelType === 'im' || channel.startsWith('D');
}

export function buildSlackAccountLinkThreadReplyText({
  slackUserId,
  dmPromptSent,
}: {
  slackUserId: string;
  dmPromptSent: boolean;
}): string {
  return buildSharedAccountLinkThreadReplyText({
    userMention: `<@${slackUserId}>`,
    dmPromptSent,
  });
}

export async function promptSlackAccountLink({
  slackUserId,
  channel,
  threadTs,
  originalText,
  slackInstallation,
  slack,
  resumeOriginalThread = true,
}: {
  slackUserId: string;
  channel: string;
  threadTs: string;
  originalText: string;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  resumeOriginalThread?: boolean;
}): Promise<SlackAccountLinkPromptResult> {
  const authToken = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15m

  const [slackAuthToken] = await db
    .insert(slackAuthTokens)
    .values({
      token: authToken,
      slackUserId,
      slackTeamId: slackInstallation.teamId,
      channel,
      threadTs,
      originalText: resumeOriginalThread
        ? originalText
        : SLACK_AUTH_NO_RESUME_SENTINEL,
      expiresAt,
    })
    .returning();

  if (!slackAuthToken) {
    throw new Error('Unable to create Slack auth token.');
  }

  const dmChannelId = await slack.openConversation(slackUserId);
  const connectMessage = buildSlackAccountLinkConnectMessage(authToken);

  if (dmChannelId) {
    try {
      const dmTs = await slack.postMessage({
        ...connectMessage,
        channel: dmChannelId,
      });

      if (!dmTs) {
        console.error(
          `[showConnectAccount] Failed to send connect prompt DM to Slack user ${slackUserId}: Slack returned no message timestamp`,
        );
      }

      return { dmPromptSent: Boolean(dmTs) };
    } catch (error) {
      console.error(
        `[showConnectAccount] Failed to send connect prompt DM to Slack user ${slackUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { dmPromptSent: false };
    }
  }

  console.warn(
    `[showConnectAccount] Could not open DM channel for Slack user ${slackUserId}; skipping connect prompt delivery`,
  );

  return { dmPromptSent: false };
}

export async function postSlackAccountLinkThreadReply({
  slack,
  channel,
  threadTs,
  slackUserId,
  dmPromptSent,
  channelType,
}: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  slackUserId: string;
  dmPromptSent: boolean;
  channelType?: string;
}): Promise<void> {
  if (isSlackDirectMessageChannel(channel, channelType)) {
    return;
  }

  await slack.postMessage({
    text: buildSlackAccountLinkThreadReplyText({
      slackUserId,
      dmPromptSent,
    }),
    channel,
    thread_ts: threadTs,
  });
}
const SLACK_IMMEDIATE_AUTO_CONFIRM_CONFIDENCE = 0.95;

/**
 * Lua script to atomically HGET + HDEL a hash field.
 * Returns the value if it existed and, when provided, the stored initiating
 * Slack user matches ARGV[2]. This ensures only one caller (manual submit vs
 * auto-confirm timer) can claim the pending selection, while binding
 * interactive actions to the original requester.
 *
 * KEYS[1] = the hash key
 * ARGV[1] = the hash field
 * ARGV[2] = the expected Slack user id, or empty string to skip user matching
 */
const CLAIM_PENDING_SELECTION_LUA = `
local val = redis.call('hget', KEYS[1], ARGV[1])
if not val then return nil end
if ARGV[2] ~= '' then
  local ok, data = pcall(cjson.decode, val)
  if not ok then return nil end
  if data.user ~= ARGV[2] then return nil end
end
redis.call('hdel', KEYS[1], ARGV[1])
return val
`;

/**
 * Lua script to atomically GET + DEL a Redis key only if the stored
 * data contains a matching nonce and, when provided, a matching Slack user.
 * When no nonce is supplied, this acts as a short-lived compatibility path for
 * legacy routing-confirm buttons that still carry only the thread id.
 *
 * KEYS[1] = the routing prefill key
 * ARGV[1] = the expected nonce, or empty string to skip nonce matching
 * ARGV[2] = the expected Slack user id, or empty string to skip user matching
 *
 * Returns the stored JSON string if nonce matches, nil otherwise.
 */
const CLAIM_ROUTING_PREFILL_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
local ok, data = pcall(cjson.decode, val)
if not ok then return nil end
if ARGV[1] ~= '' and data.confirmNonce ~= ARGV[1] then return nil end
if ARGV[2] ~= '' and data.slackUserId ~= ARGV[2] then return nil end
redis.call('del', KEYS[1])
return val
`;

/**
 * Lua script to atomically GET + DEL an MCP setup interruption only when
 * the stored nonce and Slack user both match the interactive action.
 *
 * KEYS[1] = the interruption key
 * ARGV[1] = the expected nonce
 * ARGV[2] = the expected Slack user id
 *
 * Returns the stored JSON string if nonce + user match, nil otherwise.
 */
const CLAIM_MCP_SETUP_INTERRUPT_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
local ok, data = pcall(cjson.decode, val)
if not ok then return nil end
if data.nonce ~= ARGV[1] then return nil end
if data.slackUserId ~= ARGV[2] then return nil end
redis.call('del', KEYS[1])
return val
`;

/**
 * Data stored in Redis for a pending Slack routing confirmation.
 */
interface RoutingPrefillData {
  agentName: string;
  workspaceOnly?: boolean;
  workspaceValue: string;
  workspaceDisplayName: string;
  modelId?: string;
  modelDisplayName?: string;
  workspaceType: 'environment' | 'all_repositories';
  teamId: string;
  teamDomain?: string;
  slackUserId: string;
  channel: string;
  threadMessages?: SlackThreadMessage[];
  latestOwnBotReplyText?: string;
  latestOwnBotReplyTs?: string;
  confirmMessageTs?: string;
  confirmNonce: string;
  processingReactionName?: string;
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
}

interface RoutingConfirmActionValue {
  threadId: string;
  confirmNonce?: string;
}

interface RetryFailedTaskActionValue {
  runId: number;
}

interface PendingSlackMcpSetupInterruptData {
  threadId: string;
  teamId: string;
  slackUserId: string;
  channel: string;
  originalEvent: SlackEvent;
  normalizedTaskText: string;
  serviceId: string;
  serviceName: string;
  reason: SlackMcpSetupRequirement['reason'];
  canConfigure: boolean;
  settingsUrl: string;
  copyVariant: SlackMcpSetupRequirement['copyVariant'];
  originalMessageTs: string;
  nonce: string;
}

export function getSlackRoutingAutoConfirmDelayMs(
  routingDebug?: RoutingDebugInfo,
  workspaceType?: 'environment' | 'all_repositories',
): number | undefined {
  return typeof routingDebug?.confidence === 'number' &&
    routingDebug.confidence >= SLACK_IMMEDIATE_AUTO_CONFIRM_CONFIDENCE &&
    routingDebug.workspaceRemapped !== true &&
    workspaceType !== 'all_repositories'
    ? 0
    : undefined;
}

/**
 * Atomically claims a pending workspace selection from Redis.
 * Returns the stored event JSON if the selection existed, null otherwise.
 * Only one concurrent caller will get a non-null result.
 */
async function claimPendingSelection(
  threadId: string,
  expectedSlackUserId?: string,
): Promise<string | null> {
  const result = await getRedis().eval(
    CLAIM_PENDING_SELECTION_LUA,
    1,
    REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
    threadId,
    expectedSlackUserId ?? '',
  );
  return result as string | null;
}

/**
 * Atomically claims routing prefill data from Redis only if the nonce matches.
 * Returns the stored JSON if the nonce matches, null otherwise.
 * Prevents stale auto-confirm timers from consuming corrected data.
 */
async function claimRoutingPrefillWithNonce(
  threadId: string,
  expectedNonce?: string,
  expectedSlackUserId?: string,
): Promise<string | null> {
  const result = await getRedis().eval(
    CLAIM_ROUTING_PREFILL_LUA,
    1,
    `${ROUTING_PREFILL_PREFIX}${threadId}`,
    expectedNonce ?? '',
    expectedSlackUserId ?? '',
  );
  return result as string | null;
}

function parseRoutingConfirmActionValue(
  rawValue: string | null | undefined,
): RoutingConfirmActionValue | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { threadId: rawValue };
    }

    const parsedObject = parsed as Partial<RoutingConfirmActionValue>;

    if (typeof parsedObject.threadId !== 'string') {
      return null;
    }

    return {
      threadId: parsedObject.threadId,
      confirmNonce:
        typeof parsedObject.confirmNonce === 'string'
          ? parsedObject.confirmNonce
          : undefined,
    };
  } catch {
    return { threadId: rawValue };
  }
}

function parseRetryFailedTaskActionValue(
  rawValue: string | null | undefined,
): RetryFailedTaskActionValue | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const parsedObject = parsed as Partial<{
        runId: number | string;
      }>;
      const runId =
        typeof parsedObject.runId === 'number'
          ? parsedObject.runId
          : Number.parseInt(parsedObject.runId ?? '', 10);

      if (!Number.isInteger(runId) || runId <= 0) {
        return null;
      }

      return { runId };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Atomically claims Slack MCP setup interruption data only if the nonce
 * and clicking Slack user from the interactive action match the stored
 * interruption data.
 */
async function claimSlackMcpSetupInterruptWithNonce(
  threadId: string,
  expectedNonce: string,
  expectedSlackUserId: string,
): Promise<string | null> {
  const result = await getRedis().eval(
    CLAIM_MCP_SETUP_INTERRUPT_LUA,
    1,
    getSlackMcpSetupInterruptKey(threadId),
    expectedNonce,
    expectedSlackUserId,
  );
  return result as string | null;
}

/**
 * Checks if there is a pending routing confirmation for a thread.
 * Used to detect whether an incoming message is a correction to a routing suggestion.
 */
export async function hasPendingRoutingConfirmation(
  threadId: string,
): Promise<boolean> {
  const exists = await getRedis().exists(
    `${ROUTING_PREFILL_PREFIX}${threadId}`,
  );
  return exists === 1;
}

function getSlackMcpSetupInterruptKey(threadId: string): string {
  return `${MCP_SETUP_INTERRUPT_PREFIX}${threadId}`;
}

export async function hasPendingSlackMcpSetupInterrupt(
  threadId: string,
): Promise<boolean> {
  const exists = await getRedis().exists(
    getSlackMcpSetupInterruptKey(threadId),
  );
  return exists === 1;
}

export async function clearPendingSlackMcpSetupInterrupt(
  threadId: string,
): Promise<void> {
  await getRedis().del(getSlackMcpSetupInterruptKey(threadId));
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 * Slack Block Kit has a character limit for text fields in options.
 */
function truncateText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 3) + '...';
}

function buildSlackMcpSetupInterruptBlocks(
  data: Pick<
    PendingSlackMcpSetupInterruptData,
    | 'serviceName'
    | 'reason'
    | 'canConfigure'
    | 'settingsUrl'
    | 'copyVariant'
    | 'nonce'
  >,
): SlackBlock[] {
  const secondaryText =
    data.copyVariant === 'deployment_disabled_non_admin'
      ? `To do that, please ask a ${PRODUCT_NAME} admin to enable it in the web app.`
      : data.copyVariant === 'deployment_auth_required_non_admin'
        ? `To do that, please ask a ${PRODUCT_NAME} admin to connect it in the web app.`
        : data.copyVariant === 'deployment_disabled_admin'
          ? 'To do that, please enable it in the web app.'
          : data.copyVariant === 'deployment_auth_required_admin'
            ? 'To do that, please finish connecting it in the web app.'
            : 'To do that, please enable it in the web app and then link your account.';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `That seems like a ${data.serviceName} link.\nWant me to be able to read it?\n*${secondaryText}*`,
      },
    },
    {
      type: 'actions',
      block_id: 'mcp_setup_interrupt',
      elements: [
        {
          type: 'button',
          action_id: 'mcp_setup_configure',
          text: {
            type: 'plain_text',
            text: data.canConfigure ? 'Configure' : 'Open settings',
            emoji: false,
          },
          url: data.settingsUrl,
          style: 'primary',
          value: data.nonce,
        },
        {
          type: 'button',
          action_id: 'mcp_setup_ignore',
          text: { type: 'plain_text', text: 'Nah, keep going', emoji: true },
          value: data.nonce,
        },
      ],
    },
  ];
}

function buildSlackMcpSetupFollowUpBlocks(
  copyVariant: PendingSlackMcpSetupInterruptData['copyVariant'],
): SlackBlock[] {
  const text =
    copyVariant === 'deployment_disabled_non_admin'
      ? 'Ask an admin to finish setup in the web app, then send this request again.'
      : copyVariant === 'deployment_auth_required_non_admin'
        ? 'Ask an admin to connect it in the web app, then send this request again.'
        : 'Finish setup in the web app, then send this request again.';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}

function buildPlatformAnswerMessage(
  answer: string,
): Pick<SlackMessage, 'blocks' | 'text'> {
  const docsUrl = getDefaultDocsUrl(Env.APP_ENV ?? 'development');

  return {
    text: answer,
    blocks: [
      {
        type: 'markdown',
        text: answer,
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_Learn more in the <${docsUrl}|docs>._`,
          },
        ],
      },
    ],
  };
}

async function addSlackProcessingReaction({
  slack,
  channel,
  messageTs,
  reactionName = 'eyes',
}: {
  slack: SlackNotifier;
  channel: string;
  messageTs: string;
  reactionName?: string;
}): Promise<void> {
  await slack
    .addReaction({
      channel,
      timestamp: messageTs,
      name: reactionName,
    })
    .catch(() => {});
}

async function removeSlackProcessingReaction({
  slack,
  channel,
  messageTs,
  reactionName = 'eyes',
}: {
  slack: SlackNotifier;
  channel: string;
  messageTs: string;
  reactionName?: string;
}): Promise<void> {
  await slack
    .removeReaction({
      channel,
      timestamp: messageTs,
      name: reactionName,
    })
    .catch(() => {});
}

async function postOrReplaceSlackMessage({
  slack,
  channel,
  threadId,
  replaceMessageTs,
  message,
}: {
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  replaceMessageTs?: string;
  message: Pick<SlackMessage, 'blocks' | 'text'>;
}): Promise<string | undefined> {
  if (replaceMessageTs) {
    const updated = await slack.updateMessage({
      channel,
      ts: replaceMessageTs,
      message,
    });
    if (updated) {
      return replaceMessageTs;
    }
  }

  return await slack.postMessage({
    ...message,
    channel,
    thread_ts: threadId,
  });
}

export async function showConnectAccount(
  event: SlackEvent,
  slackInstallation: SlackInstallation,
  slack: SlackNotifier,
) {
  const threadId = event.thread_ts || event.ts;
  const promptResult = await promptSlackAccountLink({
    slackUserId: event.user,
    channel: event.channel,
    threadTs: threadId,
    originalText: event.text,
    slackInstallation,
    slack,
  });

  await postSlackAccountLinkThreadReply({
    slack,
    channel: event.channel,
    threadTs: threadId,
    slackUserId: event.user,
    dmPromptSent: promptResult.dmPromptSent,
    channelType: event.channel_type,
  });
}

export async function handleConnectAccount(payload: SlackInteractivePayload) {
  // Keep the connect prompt visible after click so users can retry if auth
  // fails or if they abandon the browser flow before completion.
  void payload;
}

/**
 * Maps a RoutingWorkspace to a Slack workspace selection value (with prefix).
 */
export function mapRoutingWorkspaceToSelectionValue(
  workspace: RoutingWorkspace,
): string {
  switch (workspace.type) {
    case 'environment':
      return `${ENV_PREFIX}${workspace.id}`;
    case 'all_repositories':
      return `${REPO_PREFIX}${ALL_REPOSITORIES}`;
  }
}

/**
 * Builds Block Kit blocks for the routing confirmation message.
 * Includes the confirmation text and OK/No action buttons.
 */
export function buildRoutingConfirmBlocks(
  workspaceDisplayName: string,
  modelDisplayName: string | undefined,
  actionValue: RoutingConfirmActionValue,
): SlackBlock[] {
  const text = buildRoutingConfirmationText({
    workspaceDisplayName,
    modelDisplayName,
    formatWorkspaceName: formatSlackCode,
    formatModelName: formatSlackCode,
  });
  const serializedActionValue = JSON.stringify(actionValue);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
    {
      type: 'actions',
      block_id: 'routing_confirm',
      elements: [
        {
          type: 'button',
          action_id: 'routing_confirm_ok',
          text: { type: 'plain_text', text: 'OK', emoji: true },
          value: serializedActionValue,
          style: 'primary',
        },
        {
          type: 'button',
          action_id: 'routing_confirm_no',
          text: { type: 'plain_text', text: 'Nope', emoji: true },
          value: serializedActionValue,
        },
      ],
    },
  ];
}

function mapSelectionValueToRouterDebugChoice(
  workspaceValueWithPrefix: string,
  workspaceDisplayName: string,
): { name: string; type: string } {
  if (workspaceValueWithPrefix.startsWith(ENV_PREFIX)) {
    return {
      name: workspaceDisplayName,
      type: 'environment',
    };
  }

  const workspaceValue = workspaceValueWithPrefix.startsWith(REPO_PREFIX)
    ? workspaceValueWithPrefix.slice(REPO_PREFIX.length)
    : workspaceValueWithPrefix;

  if (workspaceValue === ALL_REPOSITORIES) {
    return {
      name: 'all repos',
      type: 'all_repositories',
    };
  }

  return {
    name: workspaceDisplayName,
    type: 'repository',
  };
}

function postSlackFinalRouterDebug({
  source,
  sourceLink,
  taskDescription,
  selectedWorkspace,
  reasoning,
  routingDebug,
  routingDurationMs,
  userRoute,
}: {
  source: string;
  sourceLink?: string;
  taskDescription: string;
  selectedWorkspace: { name: string; type: string };
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
}) {
  void postRouterDebugMessage({
    source,
    sourceLink,
    taskDescription,
    selectedWorkspace,
    reasoning: reasoning ?? '',
    routingDebug,
    routingDurationMs,
    userRoute,
  });
}

export async function showTaskConfiguration({
  event,
  slackInstallation,
  userMapping,
  slack,
  skipRouting,
  skipMcpSetupInterrupt,
  replaceMessageTs,
  processingReactionName,
}: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  slack: SlackNotifier;
  skipRouting?: boolean;
  skipMcpSetupInterrupt?: boolean;
  /** When provided, update this message instead of posting a new one. */
  replaceMessageTs?: string;
  processingReactionName?: string;
}): Promise<{
  routingUsed: boolean;
  threadId: string;
  confirmNonce?: string;
  autoConfirmDelayMs?: number;
  startedImmediately?: boolean;
}> {
  const threadId = event.thread_ts || event.ts;
  const redis = getRedis();
  const deliveryTracker = new SlackThreadDeliveryTracker(
    event.channel,
    threadId,
  );

  try {
    const threadRootExists = await slack.hasMessageInThread({
      channel: event.channel,
      threadTs: threadId,
      messageTs: threadId,
    });

    if (threadRootExists === false) {
      console.log(
        `[SlackRouting] Skipping task configuration because thread root ${threadId} is no longer available in channel ${event.channel}`,
      );
      return { routingUsed: false, threadId };
    }

    const repos = await db.query.repositories.findMany({
      where: eq(repositories.isActive, true),
      columns: {
        name: true,
        fullName: true,
        description: true,
      },
      orderBy: (repositories, { asc }) => [asc(repositories.name)],
    });

    // Fetch environments for the deployment
    const envs = await db.query.environments.findMany({
      where: eq(environments.isEval, false),
      columns: {
        id: true,
        name: true,
        description: true,
        config: true,
      },
      orderBy: (environments, { asc }) => [asc(environments.name)],
    });

    if (repos.length === 0) {
      await postOrReplaceSlackMessage({
        slack,
        channel: event.channel,
        threadId,
        replaceMessageTs,
        message: {
          text: 'Roomote needs an environment before it can start Slack tasks.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Hi! I can help once Roomote has an environment to use.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Please go to <${Env.R_APP_URL}/settings/environments|your ${PRODUCT_NAME} environment settings> and create an environment with at least one repository, then ping me back here again.`,
              },
            },
          ],
        },
      });
      return { routingUsed: false, threadId };
    }

    // Variable to hold routing result for pre-filling the selection UI
    let routingResult: RoutingResult | null = null;
    let suggestedRoutingDurationMs: number | undefined;
    let routingThreadMessages: SlackThreadMessage[] | undefined;
    let latestOwnBotReply:
      | { ts: string; text: string; displayName: string }
      | undefined;
    const taskDescription = stripLeadingSlackProductMention(
      await slack.normalizeIncomingText(
        stripLeadingRawSlackMention(event.text),
      ),
    );

    if (!skipRouting) {
      try {
        if (!skipMcpSetupInterrupt) {
          const setupRequirement = await detectSlackMcpSetupRequirement(
            taskDescription,
            {
              userId: userMapping.userId,
              apiBaseUrl: Env.R_APP_URL,
            },
          );

          if (setupRequirement) {
            void maybeNotifyManagerChannelForMcpSetupRequirement({
              triggeredByUserId: userMapping.userId,
              triggeredBySlackUserId: event.user,
              requirement: setupRequirement,
              slack,
            }).catch((error) => {
              console.warn(
                `[SlackMcpSetup] Failed to notify manager channel: ${error instanceof Error ? error.message : String(error)}`,
              );
            });

            const interruptData: PendingSlackMcpSetupInterruptData = {
              threadId,
              teamId: slackInstallation.teamId,
              slackUserId: event.user,
              channel: event.channel,
              originalEvent: event,
              normalizedTaskText: taskDescription,
              serviceId: setupRequirement.serviceId,
              serviceName: setupRequirement.serviceName,
              reason: setupRequirement.reason,
              canConfigure: setupRequirement.canConfigure,
              settingsUrl: setupRequirement.settingsUrl,
              copyVariant: setupRequirement.copyVariant,
              originalMessageTs: event.ts,
              nonce: randomUUID(),
            };

            await redis.set(
              getSlackMcpSetupInterruptKey(threadId),
              JSON.stringify(interruptData),
              'EX',
              MCP_SETUP_INTERRUPT_TTL_SECONDS,
            );

            await postOrReplaceSlackMessage({
              slack,
              channel: event.channel,
              threadId,
              replaceMessageTs,
              message: {
                blocks: buildSlackMcpSetupInterruptBlocks(interruptData),
              },
            });

            return { routingUsed: false, threadId };
          }
        }

        // Fetch thread messages for context if this is a reply in a thread
        let threadMessages: SlackThreadMessage[] | undefined;

        if (event.thread_ts) {
          try {
            console.log(
              `[LLM Router] Fetching thread messages for routing context (channel: ${event.channel}, thread_ts: ${threadId})`,
            );

            const splitMessages = await getPromptReadyThreadMessages({
              slack,
              channel: event.channel,
              threadTs: threadId,
              botUserId: slackInstallation.botUserId,
            });
            threadMessages = splitMessages.contextMessages;
            latestOwnBotReply = splitMessages.latestOwnBotReply;
          } catch (error) {
            console.warn(
              `[LLM Router] Failed to fetch thread messages for routing: ${error instanceof Error ? error.message : String(error)}`,
            );
            // Continue without thread context
          }
        }
        routingThreadMessages = threadMessages;

        // Build routing context - extract simplified thread messages for LLM prompt
        const routingTaskDescription = appendAttachmentTextsToPromptText({
          text: taskDescription,
          attachmentTexts: event.processedAttachmentTexts,
        });
        const channelName =
          (await slack.getChannelName?.(event.channel)) ?? undefined;

        const routingContext = await buildSlackRoutingContext({
          userId: userMapping.userId,
          taskDescription: routingTaskDescription,
          channelName,
          threadMessages: threadMessages?.map((m) => ({
            text: m.text,
            user: m.user,
          })),
          ...(event.processedImages?.length
            ? { images: event.processedImages }
            : {}),
          ...(event.processedVideoDescriptions?.length
            ? { videoDescriptions: event.processedVideoDescriptions }
            : {}),
          apiBaseUrl: Env.TRPC_URL,
        });

        console.log(
          `[LLM Router] Attempting to route Slack task (channel: ${event.channel}, envs: ${routingContext.availableEnvironments.length})`,
        );

        // Attempt LLM routing - result is used to pre-fill the selection UI
        const routingStart = Date.now();
        const decision = await routeTask(routingContext);
        suggestedRoutingDurationMs = Date.now() - routingStart;

        if (decision.status === 'platform_answer') {
          try {
            await postOrReplaceSlackMessage({
              slack,
              channel: event.channel,
              threadId,
              replaceMessageTs,
              message: buildPlatformAnswerMessage(decision.result.answer),
            });
          } finally {
            await removeSlackProcessingReaction({
              slack,
              channel: event.channel,
              messageTs: event.ts,
              reactionName: processingReactionName,
            });
          }

          return { routingUsed: false, threadId };
        }

        if (decision.status === 'routed') {
          console.log(
            `[LLM Router] Slack workspace suggestion: ${JSON.stringify(decision.result.workspace)}`,
          );

          routingResult = decision.result;
        } else {
          console.log(
            `[LLM Router] Slack routing returned fallback, using default selections: ${decision.reason}`,
          );
        }
      } catch (error) {
        console.error(
          `[LLM Router] Error during Slack routing, using default selections: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // If routing succeeded, show a confirmation message instead of the selection UI.
    // The user can click OK or reply with corrections.
    if (routingResult) {
      const workspaceValue = mapRoutingWorkspaceToSelectionValue(
        routingResult.workspace,
      );

      const isEnvironment = workspaceValue.startsWith(ENV_PREFIX);

      const workspaceId = isEnvironment
        ? workspaceValue.slice(ENV_PREFIX.length)
        : workspaceValue.startsWith(REPO_PREFIX)
          ? workspaceValue.slice(REPO_PREFIX.length)
          : workspaceValue;

      let workspaceDisplayName: string;

      if (isEnvironment) {
        const env = envs.find((e) => e.id === workspaceId);
        workspaceDisplayName = env?.name ?? workspaceId;
      } else {
        workspaceDisplayName =
          workspaceId === ALL_REPOSITORIES ? 'all repos' : workspaceId;
      }

      const agentName = AGENT_DISPLAY_NAME;
      const workspaceOnly = routingResult.workspaceOnly === true;
      const autoConfirmDelayMs = getSlackRoutingAutoConfirmDelayMs(
        routingResult.debug,
        routingResult.workspace.type,
      );

      if (autoConfirmDelayMs === 0) {
        const workspace = await resolveWorkspace(workspaceValue);

        if (workspace) {
          const startResult = await startImmediateSlackTask({
            event,
            slackInstallation,
            userMapping,
            slack,
            deliveryTracker,
            threadId,
            workspace,
            workspaceValue,
            workspaceType: routingResult.workspace.type,
            agentName,
            workspaceOnly,
            processingReactionName,
            replaceMessageTs,
            threadMessages: routingThreadMessages,
            latestOwnBotReply,
            modelId: routingResult.model?.id,
            modelDisplayName: routingResult.model?.displayName,
            reasoning: routingResult.reasoning,
            routingDebug: routingResult.debug,
            routingDurationMs: suggestedRoutingDurationMs,
            routingUsed: true,
          });

          if (startResult.reusedExistingRun) {
            console.log(
              `[LLM Router] Reused active task for thread ${threadId}: ` +
                `agent=${agentName}, workspace=${workspace.workspaceDisplayName}`,
            );

            return startResult.response;
          }

          console.log(
            `[LLM Router] Started routed task immediately for thread ${threadId}: ` +
              `agent=${agentName}, workspace=${workspace.workspaceDisplayName}`,
          );

          return startResult.response;
        }
      }

      await redis.hset(
        REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
        threadId,
        JSON.stringify(event satisfies SlackEvent),
      );

      const confirmNonce = randomUUID();
      const confirmBlocks: SlackBlock[] = buildRoutingConfirmBlocks(
        workspaceDisplayName,
        routingResult.model?.displayName,
        { threadId, confirmNonce },
      );

      const confirmMessageTs = await postOrReplaceSlackMessage({
        slack,
        channel: event.channel,
        threadId,
        replaceMessageTs,
        message: {
          blocks: confirmBlocks,
        },
      });

      const prefillData: RoutingPrefillData = {
        agentName,
        workspaceOnly,
        workspaceValue,
        workspaceDisplayName,
        modelId: routingResult.model?.id,
        modelDisplayName: routingResult.model?.displayName,
        workspaceType: routingResult.workspace.type,
        teamId: slackInstallation.teamId,
        teamDomain: slackInstallation.teamDomain ?? undefined,
        slackUserId: event.user,
        channel: event.channel,
        threadMessages: routingThreadMessages,
        latestOwnBotReplyText: latestOwnBotReply?.text,
        latestOwnBotReplyTs: latestOwnBotReply?.ts,
        confirmMessageTs,
        confirmNonce,
        processingReactionName,
        reasoning: routingResult.reasoning,
        routingDebug: routingResult.debug,
        routingDurationMs: suggestedRoutingDurationMs,
      };

      await getRedis().set(
        `${ROUTING_PREFILL_PREFIX}${threadId}`,
        JSON.stringify(prefillData),
        'EX',
        120,
      );

      console.log(
        `[LLM Router] Posted routing confirmation for thread ${threadId}: ` +
          `agent=${agentName}, workspace=${workspaceDisplayName}`,
      );

      return {
        routingUsed: true,
        threadId,
        confirmNonce,
        autoConfirmDelayMs,
      };
    }

    // Routing failed or was skipped - show the manual selection UI as fallback

    const blocks: SlackBlock[] = [];

    // Build workspace options with Environments first, then Repositories
    const workspaceOptions: Array<{
      text: { type: 'plain_text'; text: string };
      description?: { type: 'plain_text'; text: string };
      value: string;
    }> = [];

    // Add the environments section if any exist
    if (envs.length > 0) {
      workspaceOptions.push(
        ...envs.map((env) => ({
          text: {
            type: 'plain_text' as const,
            text: truncateText(`🖥️ ${env.name}`),
          },
          ...(env.description && {
            description: {
              type: 'plain_text' as const,
              text: truncateText(env.description),
            },
          }),
          value: `${ENV_PREFIX}${env.id}`,
        })),
      );
    }

    // Add "All repositories" option when repos exist
    if (repos.length > 0) {
      workspaceOptions.push({
        text: {
          type: 'plain_text',
          text: truncateText('All repositories'),
        },
        value: `${REPO_PREFIX}${ALL_REPOSITORIES}`,
      });
    }

    let lastSelectedWorkspace: string | null = null;
    const lastWorkspaceKey = `last_workspace:${userMapping.userId}`;
    lastSelectedWorkspace = await getRedis().get(lastWorkspaceKey);

    // Determine the default option:
    // - If there are environments, default to the first environment
    // - Otherwise default to "All repositories"
    const allReposIndex = envs.length;

    const defaultOption =
      workspaceOptions[envs.length > 0 ? 0 : allReposIndex] ||
      workspaceOptions[0];

    // Priority: last selected > default
    // (routing pre-fill is handled by the confirmation message path above)
    const lastWorkspaceOption = lastSelectedWorkspace
      ? workspaceOptions.find(
          (option) => option.value === lastSelectedWorkspace,
        )
      : undefined;

    const initialWorkspaceOption = lastWorkspaceOption || defaultOption;

    const allRepositoriesSelection = `${REPO_PREFIX}${ALL_REPOSITORIES}`;

    if (
      workspaceOptions.length === 1 &&
      workspaceOptions[0]?.value === allRepositoriesSelection
    ) {
      const workspace = await resolveWorkspace(allRepositoriesSelection);

      if (workspace) {
        let fallbackThreadMessages = routingThreadMessages;
        let fallbackLatestOwnBotReply = latestOwnBotReply;

        if (!fallbackThreadMessages && event.thread_ts) {
          try {
            const splitMessages = await getPromptReadyThreadMessages({
              slack,
              channel: event.channel,
              threadTs: threadId,
              botUserId: slackInstallation.botUserId,
            });
            fallbackThreadMessages = splitMessages.contextMessages;
            fallbackLatestOwnBotReply = splitMessages.latestOwnBotReply;
          } catch (error) {
            console.warn(
              `[SlackRouting] Failed to fetch thread messages for single-option start: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const startResult = await startImmediateSlackTask({
          event,
          slackInstallation,
          userMapping,
          slack,
          deliveryTracker,
          threadId,
          workspace,
          workspaceValue: allRepositoriesSelection,
          workspaceType: 'all_repositories',
          agentName: AGENT_DISPLAY_NAME,
          workspaceOnly: false,
          processingReactionName,
          replaceMessageTs,
          threadMessages: fallbackThreadMessages,
          latestOwnBotReply: fallbackLatestOwnBotReply,
          routingDurationMs: suggestedRoutingDurationMs,
          routingUsed: false,
          reusedExistingStartedImmediately: true,
        });

        if (startResult.reusedExistingRun) {
          return startResult.response;
        }

        console.log(
          `[SlackRouting] Started task immediately for thread ${threadId} because all repositories is the only available workspace`,
        );

        return startResult.response;
      }
    }

    // Workspace selection: use radio buttons for few options, select dropdown otherwise
    if (workspaceOptions.length <= MAX_RADIO_BUTTON_OPTIONS) {
      // Convert options to radio button format with separate text and description fields
      const radioWorkspaceOptions = workspaceOptions.map((option) => ({
        text: {
          type: 'plain_text' as const,
          text: option.text.text,
        },
        ...(option.description && { description: option.description }),
        value: option.value,
      }));

      const radioInitialOption = lastSelectedWorkspace
        ? radioWorkspaceOptions.find(
            (option) => option.value === lastSelectedWorkspace,
          ) ||
          radioWorkspaceOptions[envs.length > 0 ? 0 : allReposIndex] ||
          radioWorkspaceOptions[0]
        : radioWorkspaceOptions[envs.length > 0 ? 0 : allReposIndex] ||
          radioWorkspaceOptions[0];

      blocks.push(
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Which environment should I use?' },
        },
        {
          type: 'actions',
          block_id: 'workspace_selection',
          elements: [
            {
              type: 'radio_buttons',
              action_id: 'workspace_selection',
              initial_option: radioInitialOption,
              options: radioWorkspaceOptions,
            },
          ],
        },
      );
    } else {
      // Dropdown on its own line (separate from label) for better readability
      blocks.push(
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Which environment should I use?' },
        },
        {
          type: 'actions',
          block_id: 'workspace_selection',
          elements: [
            {
              type: 'static_select',
              action_id: 'workspace_selection',
              placeholder: {
                type: 'plain_text',
                text: 'Choose an environment',
              },
              initial_option: initialWorkspaceOption,
              options: workspaceOptions,
            },
          ],
        },
      );
    }

    blocks.push({
      block_id: 'submit_task',
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Start →', emoji: true },
          style: 'primary',
          action_id: 'submit_task',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Nevermind', emoji: true },
          action_id: 'nevermind_task',
        },
      ],
    });

    await redis.hset(
      REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
      threadId,
      JSON.stringify(event satisfies SlackEvent),
    );

    await postOrReplaceSlackMessage({
      slack,
      channel: event.channel,
      threadId,
      replaceMessageTs,
      message: { blocks },
    });

    return { routingUsed: false, threadId };
  } finally {
    await deliveryTracker.commit();
  }
}

export async function handleSlackMcpSetupConfigure(
  payload: SlackInteractivePayload,
) {
  const threadId = payload.message.thread_ts || payload.message.ts;
  const expectedNonce =
    payload.actions[0]?.type === 'button'
      ? (payload.actions[0].value ?? undefined)
      : undefined;

  if (!expectedNonce) {
    console.warn(
      `[SlackMcpSetupConfigure] Missing nonce for thread ${threadId}; ignoring stale or malformed action`,
    );
    return;
  }

  const interruptJson = await claimSlackMcpSetupInterruptWithNonce(
    threadId,
    expectedNonce,
    payload.user.id,
  );

  if (!interruptJson) {
    return;
  }

  let interrupt: PendingSlackMcpSetupInterruptData;
  try {
    interrupt = JSON.parse(interruptJson) as PendingSlackMcpSetupInterruptData;
  } catch {
    console.error(
      `[SlackMcpSetupConfigure] Failed to parse interrupt data for thread ${threadId}`,
    );
    return;
  }

  await postSlackInteractiveResponse(payload.response_url, {
    replace_original: true,
    blocks: buildSlackMcpSetupFollowUpBlocks(interrupt.copyVariant),
  });
}

export async function handleSlackMcpSetupIgnore(
  payload: SlackInteractivePayload,
) {
  const teamId = payload.team.id;
  const threadId = payload.message.thread_ts || payload.message.ts;
  const expectedNonce =
    payload.actions[0]?.type === 'button'
      ? (payload.actions[0].value ?? undefined)
      : undefined;

  if (!expectedNonce) {
    console.warn(
      `[SlackMcpSetupIgnore] Missing nonce for thread ${threadId}; ignoring stale or malformed action`,
    );
    return;
  }

  const interruptJson = await claimSlackMcpSetupInterruptWithNonce(
    threadId,
    expectedNonce,
    payload.user.id,
  );

  if (!interruptJson) {
    return;
  }

  let interrupt: PendingSlackMcpSetupInterruptData;
  try {
    interrupt = JSON.parse(interruptJson) as PendingSlackMcpSetupInterruptData;
  } catch {
    console.error(
      `[SlackMcpSetupIgnore] Failed to parse interrupt data for thread ${threadId}`,
    );
    return;
  }

  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!slackInstallation) {
    console.error('[SlackMcpSetupIgnore] Slack installation not found');
    return;
  }

  const [userMapping] = await db
    .select()
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.slackUserId, interrupt.originalEvent.user),
        eq(slackUserMappings.slackTeamId, teamId),
      ),
    )
    .limit(1);

  if (!userMapping) {
    console.error('[SlackMcpSetupIgnore] User mapping not found');
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);

  await showTaskConfiguration({
    event: interrupt.originalEvent,
    slackInstallation,
    userMapping,
    slack,
    skipMcpSetupInterrupt: true,
    replaceMessageTs: payload.message.ts,
  });
}

export async function handleTaskConfiguration(
  payload: SlackInteractivePayload,
) {
  const teamId = payload.team.id;
  const threadId = payload.message.thread_ts || payload.message.ts;
  const redis = getRedis();
  const deliveryTracker = new SlackThreadDeliveryTracker(
    payload.channel.id,
    threadId,
  );

  let slack: SlackNotifier | undefined = undefined;

  try {
    // Atomically claim the pending selection so a concurrent auto-confirm
    // timer cannot also process it (prevents duplicate job creation).
    const originalEventJson = await claimPendingSelection(
      threadId,
      payload.user.id,
    );

    if (!originalEventJson) {
      console.warn(
        `[TaskConfiguration] Pending selection missing or unauthorized for thread ${threadId}; ignoring action`,
      );
      return;
    }

    const prefillJson = await redis.getdel(
      `${ROUTING_PREFILL_PREFIX}${threadId}`,
    );
    let prefill: RoutingPrefillData | undefined;
    if (prefillJson) {
      try {
        prefill = JSON.parse(prefillJson) as RoutingPrefillData;
      } catch {
        console.warn(
          `[TaskConfiguration] Failed to parse routing prefill for thread ${threadId}`,
        );
      }
    }

    let originalEvent: SlackEvent;

    try {
      originalEvent = JSON.parse(originalEventJson);
    } catch {
      throw new Error('Failed to parse original event data');
    }

    const [slackInstallation] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);

    if (!slackInstallation) {
      throw new Error('Slack installation not found.');
    }

    const [userMapping] = await db
      .select()
      .from(slackUserMappings)
      .where(
        and(
          eq(slackUserMappings.slackUserId, originalEvent.user),
          eq(slackUserMappings.slackTeamId, teamId),
        ),
      )
      .limit(1);

    if (!userMapping) {
      throw new Error(
        'User mapping not found. Please connect your account first.',
      );
    }

    slack = new SlackNotifier(slackInstallation.botAccessToken);

    const images = originalEvent.processedImages || [];

    // Fetch thread messages for context if this is a reply in a thread.
    // This provides the AI with the full conversation history, enabling better
    // context-aware responses. If fetching fails, we continue without thread context
    // as this is a non-critical enhancement.
    let threadMessages:
      | Awaited<ReturnType<typeof slack.fetchThreadMessages>>
      | undefined;
    let latestOwnBotReply:
      | { ts: string; text: string; displayName: string }
      | undefined;
    if (originalEvent.thread_ts) {
      try {
        console.log(
          `📋 Fetching thread messages for context (channel: ${originalEvent.channel}, thread_ts: ${threadId})`,
        );
        const splitMessages = await getPromptReadyThreadMessages({
          slack: slack!,
          channel: originalEvent.channel,
          threadTs: threadId,
          botUserId: slackInstallation.botUserId,
        });
        threadMessages = splitMessages.contextMessages;
        latestOwnBotReply = splitMessages.latestOwnBotReply;

        console.log(
          `📋 Fetched ${threadMessages.length} thread messages for context`,
        );
      } catch (error) {
        console.error(
          `⚠️ Failed to fetch thread messages: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Continue without thread context - non-critical error
      }
    } else {
      console.log('ℹ️ No thread context available (not a thread reply)');
    }

    const agentName = AGENT_DISPLAY_NAME;
    let selectedWorkspace: string | undefined = undefined;

    const workspaceSelection =
      payload.state.values.workspace_selection?.workspace_selection;

    if (
      workspaceSelection?.type === 'static_select' ||
      workspaceSelection?.type === 'radio_buttons'
    ) {
      selectedWorkspace = workspaceSelection.selected_option?.value;
    }

    if (!selectedWorkspace) {
      await slack.postMessage({
        text: 'Please select an environment before submitting.',
        channel: payload.channel.id,
        thread_ts: threadId,
      });

      return;
    }

    // Parse workspace selection to determine if it's an environment or repository
    const isEnvironment = selectedWorkspace.startsWith(ENV_PREFIX);
    const isRepository = selectedWorkspace.startsWith(REPO_PREFIX);
    const workspaceValue = isEnvironment
      ? selectedWorkspace.slice(ENV_PREFIX.length)
      : isRepository
        ? selectedWorkspace.slice(REPO_PREFIX.length)
        : selectedWorkspace;

    // If an environment is selected, fetch it to get the first repository
    let environmentId: string | undefined;
    let repoForPayload: string;
    let workspaceDisplayName: string;

    if (isEnvironment) {
      const environment = await db.query.environments.findFirst({
        where: eq(environments.id, workspaceValue),
        columns: {
          id: true,
          name: true,
          config: true,
        },
      });

      if (!environment) {
        await slack.postMessage({
          text: 'The selected environment was not found.',
          channel: payload.channel.id,
          thread_ts: threadId,
        });
        return;
      }

      environmentId = environment.id;

      // Extract first repository from environment config
      const config = environment.config as {
        repositories?: Array<{ repository: string }>;
      };
      const firstRepo = config?.repositories?.[0]?.repository;

      if (!firstRepo) {
        await slack.postMessage({
          text: 'The selected environment has no repositories configured.',
          channel: payload.channel.id,
          thread_ts: threadId,
        });
        return;
      }

      repoForPayload = firstRepo;
      workspaceDisplayName = environment.name;
    } else {
      // Repository selection
      repoForPayload = workspaceValue;
      workspaceDisplayName =
        workspaceValue === ALL_REPOSITORIES ? 'all repos' : workspaceValue;
    }

    // Replace user ID mentions with display names in the main message text
    const messageText = stripLeadingSlackProductMention(
      await slack.normalizeIncomingText(
        stripLeadingRawSlackMention(originalEvent.text),
      ),
    );
    const taskText = appendSlackVideoDescriptionsToText({
      text: appendAttachmentTextsToPromptText({
        text: messageText,
        attachmentTexts: originalEvent.processedAttachmentTexts,
      }),
      videoDescriptions: originalEvent.processedVideoDescriptions,
    });

    // Tasks originating from Slack run against the deployment-wide setup.
    const taskRun = await startSlackAppMentionTask({
      initiator: {
        kind: 'user',
        externalId: originalEvent.user,
        matchedUserId: userMapping.userId,
      },
      trigger: 'manual',
      channel: originalEvent.channel,
      teamId,
      teamDomain: slackInstallation.teamDomain ?? undefined,
      slackUserId: originalEvent.user,
      text: taskText,
      ackEmoji: prefill?.processingReactionName,
      ts: originalEvent.ts,
      threadTs: threadId,
      repo: repoForPayload,
      environmentId,
      images,
      threadMessages,
      latestOwnBotReplyText: latestOwnBotReply?.text,
      latestOwnBotReplyTs: latestOwnBotReply?.ts,
      slackConversationUrl:
        (await slack?.getMessagePermalink?.({
          channel: originalEvent.channel,
          messageTs: threadId,
        })) ?? undefined,
      queuedStartedMessage: {
        ts: payload.message.ts,
        agentName,
        initiatingSlackUserId: payload.user.id,
        workspaceDisplayName,
        workspaceOnly: false,
      },
    });

    if (taskRun.reusedExistingRun) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildExistingTaskQueuedBlocks(),
      });

      const lastWorkspaceKey = `last_workspace:${userMapping.userId}`;
      await redis.set(
        lastWorkspaceKey,
        selectedWorkspace,
        'EX',
        30 * 24 * 60 * 60,
      );
      return;
    }

    deliveryTracker.track(originalEvent.ts);
    deliveryTracker.trackAll(
      threadMessages?.map((message) => message.ts) ?? [],
    );

    const routerSelectedWorkspace = prefill
      ? {
          name: prefill.workspaceDisplayName,
          type: prefill.workspaceType,
        }
      : mapSelectionValueToRouterDebugChoice(
          selectedWorkspace,
          workspaceDisplayName,
        );

    postSlackFinalRouterDebug({
      source: `Slack ${originalEvent.channel}`,
      sourceLink:
        buildSlackThreadPermalink({
          slackWorkspaceDomain: slackInstallation.teamDomain ?? undefined,
          slackChannelId: originalEvent.channel,
          threadTs: threadId || originalEvent.ts,
        }) ?? undefined,
      taskDescription: taskText,
      selectedWorkspace: routerSelectedWorkspace,
      reasoning: prefill?.reasoning,
      routingDebug: prefill?.routingDebug,
      routingDurationMs: prefill?.routingDurationMs,
      userRoute: prefill ? `${agentName} → ${workspaceDisplayName}` : undefined,
    });

    const taskUrl = getSlackStartedMessageFollowUrl({
      taskId: taskRun.taskId,
    });

    const blocks = buildStartedBlocks({
      workspaceDisplayName,
      runId: taskRun.id,
      taskId: taskRun.taskId,
      initiatingSlackUserId: payload.user.id,
      taskUrl,
    });

    // Update the original message using response_url instead of posting a new message.
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: true,
      blocks,
    });

    if (taskRun.id) {
      await setSlackStartedMessageTs(taskRun.id, payload.message.ts, {
        agentName,
        initiatingSlackUserId: payload.user.id,
        workspaceDisplayName,
        workspaceOnly: false,
      });
    }

    // Save last selected workspace
    const lastWorkspaceKey = `last_workspace:${userMapping.userId}`;
    await redis.set(
      lastWorkspaceKey,
      selectedWorkspace,
      'EX',
      30 * 24 * 60 * 60,
    );
  } catch (error) {
    console.error(
      `❌ Failed to process interactive payload: ${error instanceof Error ? error.message : String(error)}`,
    );

    await slack?.postMessage({
      text: `❌ ${error instanceof Error ? error.message : 'Unknown error'}`,
      channel: payload.channel.id,
      thread_ts: threadId,
    });
  } finally {
    await deliveryTracker.commit();
  }
}

/**
 * Shared helper that resolves a workspace value (with prefix) into
 * the repo/environmentId/displayName needed to create a task run.
 */
export async function resolveWorkspace(
  workspaceValueWithPrefix: string,
): Promise<{
  environmentId?: string;
  repoForPayload: string;
  workspaceDisplayName: string;
} | null> {
  const isEnvironment = workspaceValueWithPrefix.startsWith(ENV_PREFIX);
  const isRepository = workspaceValueWithPrefix.startsWith(REPO_PREFIX);
  const workspaceValue = isEnvironment
    ? workspaceValueWithPrefix.slice(ENV_PREFIX.length)
    : isRepository
      ? workspaceValueWithPrefix.slice(REPO_PREFIX.length)
      : workspaceValueWithPrefix;

  if (isEnvironment) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, workspaceValue),
      columns: { id: true, name: true, config: true },
    });

    if (!environment) {
      return null;
    }

    const config = environment.config as {
      repositories?: Array<{ repository: string }>;
    };
    const firstRepo = config?.repositories?.[0]?.repository;
    if (!firstRepo) {
      return null;
    }

    return {
      environmentId: environment.id,
      repoForPayload: firstRepo,
      workspaceDisplayName: environment.name,
    };
  }

  return {
    repoForPayload: workspaceValue,
    workspaceDisplayName:
      workspaceValue === ALL_REPOSITORIES ? 'all repos' : workspaceValue,
  };
}

type ResolvedWorkspace = NonNullable<
  Awaited<ReturnType<typeof resolveWorkspace>>
>;

type ImmediateSlackTaskStartResponse = {
  routingUsed: boolean;
  threadId: string;
  startedImmediately?: boolean;
};

async function startImmediateSlackTask({
  event,
  slackInstallation,
  userMapping,
  slack,
  deliveryTracker,
  threadId,
  workspace,
  workspaceValue,
  workspaceType,
  agentName,
  workspaceOnly,
  processingReactionName,
  replaceMessageTs,
  threadMessages,
  latestOwnBotReply,
  modelId,
  modelDisplayName,
  reasoning,
  routingDebug,
  routingDurationMs,
  routingUsed,
  reusedExistingStartedImmediately = false,
}: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  slack: SlackNotifier;
  deliveryTracker: SlackThreadDeliveryTracker;
  threadId: string;
  workspace: ResolvedWorkspace;
  workspaceValue: string;
  workspaceType: 'environment' | 'all_repositories';
  agentName: string;
  workspaceOnly: boolean;
  processingReactionName?: string;
  replaceMessageTs?: string;
  threadMessages?: SlackThreadMessage[];
  latestOwnBotReply?: Pick<SlackThreadMessage, 'text' | 'ts'>;
  modelId?: string;
  modelDisplayName?: string;
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  routingUsed: boolean;
  reusedExistingStartedImmediately?: boolean;
}): Promise<{
  reusedExistingRun: boolean;
  response: ImmediateSlackTaskStartResponse;
}> {
  const messageText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(stripLeadingRawSlackMention(event.text)),
  );
  const images = event.processedImages || [];
  const taskText = appendSlackVideoDescriptionsToText({
    text: appendAttachmentTextsToPromptText({
      text: messageText,
      attachmentTexts: event.processedAttachmentTexts,
    }),
    videoDescriptions: event.processedVideoDescriptions,
  });

  const taskRun = await startSlackAppMentionTask({
    initiator: {
      kind: 'user',
      externalId: event.user,
      matchedUserId: userMapping.userId,
    },
    trigger: 'manual',
    channel: event.channel,
    teamId: slackInstallation.teamId,
    teamDomain: slackInstallation.teamDomain ?? undefined,
    slackUserId: event.user,
    text: taskText,
    ackEmoji: processingReactionName,
    ts: event.ts,
    threadTs: threadId,
    repo: workspace.repoForPayload,
    model: modelId,
    environmentId: workspace.environmentId,
    images,
    threadMessages,
    latestOwnBotReplyText: latestOwnBotReply?.text,
    latestOwnBotReplyTs: latestOwnBotReply?.ts,
    slackConversationUrl:
      (await slack.getMessagePermalink?.({
        channel: event.channel,
        messageTs: threadId,
      })) ?? undefined,
    ...(replaceMessageTs
      ? {
          queuedStartedMessage: {
            ts: replaceMessageTs,
            agentName,
            initiatingSlackUserId: event.user,
            workspaceDisplayName: workspace.workspaceDisplayName,
            ...(modelDisplayName ? { modelDisplayName } : {}),
            workspaceOnly,
          },
        }
      : {}),
  });
  deliveryTracker.track(event.ts);
  deliveryTracker.trackAll(threadMessages?.map((message) => message.ts) ?? []);

  if (taskRun.reusedExistingRun) {
    await postOrReplaceSlackMessage({
      slack,
      channel: event.channel,
      threadId,
      replaceMessageTs,
      message: {
        blocks: buildExistingTaskQueuedBlocks(),
      },
    });

    return {
      reusedExistingRun: true,
      response: {
        routingUsed,
        threadId,
        ...(reusedExistingStartedImmediately
          ? { startedImmediately: true }
          : {}),
      },
    };
  }

  await finishRoutedStart({
    runId: taskRun.id,
    taskId: taskRun.taskId,
    taskDescription: taskText,
    userId: userMapping.userId,
    initiatingSlackUserId: event.user,
    agentName,
    workspaceDisplayName: workspace.workspaceDisplayName,
    modelDisplayName,
    workspaceType,
    workspaceValue,
    workspaceOnly,
    channel: event.channel,
    threadId,
    teamDomain: slackInstallation.teamDomain ?? undefined,
    reasoning,
    routingDebug,
    routingDurationMs,
    existingMessageTs: replaceMessageTs,
    slack,
  });

  return {
    reusedExistingRun: false,
    response: {
      routingUsed,
      threadId,
      startedImmediately: true,
    },
  };
}

export {
  buildStartedBlocks,
  buildTaskFailedBlocks,
  buildTaskFailedMessage,
  SLACK_RUNTIME_FAILURE_TEXT,
  SLACK_STARTUP_FAILURE_TEXT,
};

function buildExistingTaskQueuedBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Roomote is already working in this thread. I queued your latest instruction for the active task.',
      },
    },
  ];
}

/**
 * Creates the task run from routing prefill data and the original event.
 * Shared between OK-button, auto-confirm, and correction-confirm paths.
 */
async function createRunFromPrefill({
  prefill,
  originalEvent,
  threadId,
  userId,
  slack,
  deliveryTracker,
}: {
  prefill: RoutingPrefillData;
  originalEvent: SlackEvent;
  threadId: string;
  userId: string;
  slack: SlackNotifier;
  deliveryTracker: SlackThreadDeliveryTracker;
}): Promise<{
  runId: number | null;
  taskId: string | null;
  taskDescription: string;
  reusedExistingRun: boolean;
} | null> {
  const workspace = await resolveWorkspace(prefill.workspaceValue);
  if (!workspace) {
    console.error(
      `[RoutingConfirm] Failed to resolve workspace: ${prefill.workspaceValue}`,
    );
    return null;
  }

  const messageText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(
      stripLeadingRawSlackMention(originalEvent.text),
    ),
  );
  const images = originalEvent.processedImages || [];
  const taskText = appendSlackVideoDescriptionsToText({
    text: appendAttachmentTextsToPromptText({
      text: messageText,
      attachmentTexts: originalEvent.processedAttachmentTexts,
    }),
    videoDescriptions: originalEvent.processedVideoDescriptions,
  });

  const taskRun = await startSlackAppMentionTask({
    initiator: {
      kind: 'user',
      externalId: originalEvent.user,
      matchedUserId: userId,
    },
    trigger: 'manual',
    channel: originalEvent.channel,
    teamId: prefill.teamId,
    teamDomain: prefill.teamDomain,
    slackUserId: originalEvent.user,
    text: taskText,
    ackEmoji: prefill.processingReactionName,
    ts: originalEvent.ts,
    threadTs: threadId,
    repo: workspace.repoForPayload,
    model: prefill.modelId,
    environmentId: workspace.environmentId,
    images,
    threadMessages: prefill.threadMessages,
    latestOwnBotReplyText: prefill.latestOwnBotReplyText,
    latestOwnBotReplyTs: prefill.latestOwnBotReplyTs,
    slackConversationUrl:
      (await slack.getMessagePermalink?.({
        channel: originalEvent.channel,
        messageTs: threadId,
      })) ?? undefined,
    ...(prefill.confirmMessageTs
      ? {
          queuedStartedMessage: {
            ts: prefill.confirmMessageTs,
            agentName: prefill.agentName,
            initiatingSlackUserId: prefill.slackUserId,
            workspaceDisplayName: prefill.workspaceDisplayName,
            ...(prefill.modelDisplayName
              ? { modelDisplayName: prefill.modelDisplayName }
              : {}),
            workspaceOnly: prefill.workspaceOnly,
          },
        }
      : {}),
  });
  deliveryTracker.track(originalEvent.ts);
  deliveryTracker.trackAll(
    prefill.threadMessages?.map((message) => message.ts) ?? [],
  );

  return {
    runId: taskRun.id,
    taskId: taskRun.taskId,
    taskDescription: taskText,
    reusedExistingRun: taskRun.reusedExistingRun,
  };
}

/**
 * Auto-confirms a routing suggestion after the timeout period.
 * Called by the Slack handler after ROUTING_AUTO_CONFIRM_TIMEOUT_MS.
 *
 * If the user has already confirmed (OK button), corrected, or manually
 * submitted, this is a no-op. The nonce parameter prevents stale timers
 * from consuming data that belongs to a newer confirmation round.
 */
export async function autoConfirmRouting(
  threadId: string,
  expectedNonce?: string,
): Promise<void> {
  const redis = getRedis();

  // If a nonce is provided, atomically check it before claiming.
  // This prevents a stale timer (from before a user correction) from
  // consuming data that belongs to a newer confirmation.
  let prefillJson: string | null;
  if (expectedNonce) {
    prefillJson = await claimRoutingPrefillWithNonce(threadId, expectedNonce);
    if (!prefillJson) {
      console.log(
        `[AutoConfirm] Nonce mismatch or prefill already consumed for thread ${threadId}, skipping`,
      );
      return;
    }
  } else {
    // Legacy path (no nonce) – read + delete non-atomically
    prefillJson = await redis.get(`${ROUTING_PREFILL_PREFIX}${threadId}`);
    if (!prefillJson) {
      console.log(
        `[AutoConfirm] No routing pre-fill found for thread ${threadId}, skipping`,
      );
      return;
    }
    await redis.del(`${ROUTING_PREFILL_PREFIX}${threadId}`);
  }

  // Atomically claim the pending selection. If the user already submitted
  // manually (which also claims atomically), this returns null and we skip.
  const originalEventJson = await claimPendingSelection(threadId);

  if (!originalEventJson) {
    console.log(
      `[AutoConfirm] Pending selection already consumed for thread ${threadId}, skipping`,
    );
    return;
  }

  const prefill = JSON.parse(prefillJson) as RoutingPrefillData;

  let originalEvent: SlackEvent;
  try {
    originalEvent = JSON.parse(originalEventJson);
  } catch {
    console.error('[AutoConfirm] Failed to parse original event data');
    return;
  }

  // Look up slack installation
  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, prefill.teamId))
    .limit(1);

  if (!slackInstallation) {
    console.error('[AutoConfirm] Slack installation not found');
    return;
  }

  // Look up user mapping
  const [userMapping] = await db
    .select()
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.slackUserId, prefill.slackUserId),
        eq(slackUserMappings.slackTeamId, prefill.teamId),
      ),
    )
    .limit(1);

  if (!userMapping) {
    console.error('[AutoConfirm] User mapping not found');
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const deliveryTracker = new SlackThreadDeliveryTracker(
    originalEvent.channel,
    threadId,
  );

  try {
    const result = await createRunFromPrefill({
      prefill,
      originalEvent,
      threadId,
      userId: userMapping.userId,
      slack,
      deliveryTracker,
    });

    if (!result) {
      console.error('[AutoConfirm] Failed to create task run from prefill');
      return;
    }

    if (result.reusedExistingRun) {
      await postOrReplaceSlackMessage({
        slack,
        channel: prefill.channel,
        threadId,
        replaceMessageTs: prefill.confirmMessageTs ?? undefined,
        message: {
          blocks: buildExistingTaskQueuedBlocks(),
        },
      });
      return;
    }

    await finishRoutedStart({
      runId: result.runId,
      taskId: result.taskId,
      taskDescription: result.taskDescription,
      userId: userMapping.userId,
      initiatingSlackUserId: prefill.slackUserId,
      agentName: prefill.agentName,
      workspaceDisplayName: prefill.workspaceDisplayName,
      workspaceType: prefill.workspaceType,
      workspaceValue: prefill.workspaceValue,
      workspaceOnly: prefill.workspaceOnly,
      channel: prefill.channel,
      threadId,
      teamDomain: prefill.teamDomain,
      reasoning: prefill.reasoning,
      routingDebug: prefill.routingDebug,
      routingDurationMs: prefill.routingDurationMs,
      userRoute: prefill.userRoute,
      existingMessageTs: prefill.confirmMessageTs,
      slack,
    });

    console.log(
      `[AutoConfirm] Auto-confirmed routing for thread ${threadId}: ` +
        `agent=${prefill.agentName}, workspace=${prefill.workspaceDisplayName}`,
    );
  } finally {
    await deliveryTracker.commit();
  }
}

/**
 * Handles a user correction to a pending routing confirmation.
 * Re-routes with the correction text; if re-routing succeeds, posts a new
 * confirmation. If it fails, falls back to the manual selection UI.
 *
 * Returns an object indicating whether a new auto-confirm should be scheduled.
 */
export async function handleSlackRoutingCorrection({
  threadId,
  correctionText,
  event,
  slackInstallation,
  userMapping,
  slack,
  processingReactionName,
}: {
  threadId: string;
  correctionText: string;
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  slack: SlackNotifier;
  processingReactionName?: string;
}): Promise<{
  handled: boolean;
  autoConfirmData?: {
    threadId: string;
    confirmNonce: string;
    autoConfirmDelayMs?: number;
  };
}> {
  const redis = getRedis();
  const prefillKey = `${ROUTING_PREFILL_PREFIX}${threadId}`;
  const deliveryTracker = new SlackThreadDeliveryTracker(
    event.channel,
    threadId,
  );

  const prefillJson = await claimRoutingPrefillWithNonce(
    threadId,
    undefined,
    event.user,
  );
  if (!prefillJson) {
    return { handled: false };
  }

  let oldPrefill: RoutingPrefillData;
  try {
    oldPrefill = JSON.parse(prefillJson) as RoutingPrefillData;
  } catch {
    console.error(
      `[RoutingCorrection] Failed to parse routing prefill for thread ${threadId}`,
    );
    return { handled: false };
  }

  // Claim the pending selection after atomically claiming the prefill so the
  // correction path owns both pieces of state before the slow LLM call.
  const claimedEventJson = await claimPendingSelection(threadId, event.user);
  if (!claimedEventJson) {
    return { handled: false };
  }

  // Use the LLM to classify the user's follow-up as confirm, cancel, or correct
  const classification = await classifyFollowUp({
    suggestedWorkspace: oldPrefill.workspaceDisplayName,
    userResponse: correctionText,
    userId: userMapping.userId,
  });

  console.log(
    `[RoutingCorrection] Classified follow-up for thread ${threadId}: ${classification.intent} (${classification.reasoning})`,
  );

  // --- Cancel: user wants to abort the request entirely ---
  if (classification.intent === 'cancel') {
    console.log(
      `[RoutingCorrection] Cancellation detected for thread ${threadId}`,
    );

    // Delete the routing confirmation message entirely since the whole thing was a no-op
    if (oldPrefill.confirmMessageTs) {
      await slack.deleteMessage({
        channel: oldPrefill.channel,
        ts: oldPrefill.confirmMessageTs,
      });
    }

    return { handled: true };
  }

  // --- Confirm: user accepts the routing suggestion as-is ---
  if (classification.intent === 'confirm') {
    console.log(
      `[RoutingCorrection] Confirmation detected for thread ${threadId}`,
    );

    let originalEvent: SlackEvent;
    try {
      originalEvent = JSON.parse(claimedEventJson);
    } catch {
      console.error(
        '[RoutingCorrection] Failed to parse original event data for confirm',
      );
      return { handled: true };
    }

    try {
      const result = await createRunFromPrefill({
        prefill: oldPrefill,
        originalEvent,
        threadId,
        userId: userMapping.userId,
        slack,
        deliveryTracker,
      });

      if (!result) {
        console.error(
          '[RoutingCorrection] Failed to create task run from prefill on confirm',
        );
        return { handled: true };
      }

      if (result.reusedExistingRun) {
        await postOrReplaceSlackMessage({
          slack,
          channel: oldPrefill.channel,
          threadId,
          replaceMessageTs: oldPrefill.confirmMessageTs ?? undefined,
          message: {
            blocks: buildExistingTaskQueuedBlocks(),
          },
        });
        return { handled: true };
      }

      await finishRoutedStart({
        runId: result.runId,
        taskId: result.taskId,
        taskDescription: result.taskDescription,
        userId: userMapping.userId,
        initiatingSlackUserId: oldPrefill.slackUserId,
        agentName: oldPrefill.agentName,
        workspaceDisplayName: oldPrefill.workspaceDisplayName,
        modelDisplayName: oldPrefill.modelDisplayName,
        workspaceType: oldPrefill.workspaceType,
        workspaceValue: oldPrefill.workspaceValue,
        workspaceOnly: oldPrefill.workspaceOnly,
        channel: oldPrefill.channel,
        threadId,
        teamDomain: oldPrefill.teamDomain,
        reasoning: oldPrefill.reasoning,
        routingDebug: oldPrefill.routingDebug,
        routingDurationMs: oldPrefill.routingDurationMs,
        userRoute: oldPrefill.userRoute,
        existingMessageTs: oldPrefill.confirmMessageTs,
        slack,
      });

      console.log(
        `[RoutingCorrection] User confirmed routing for thread ${threadId}: ` +
          `agent=${oldPrefill.agentName}, workspace=${oldPrefill.workspaceDisplayName}`,
      );

      return { handled: true };
    } finally {
      await deliveryTracker.commit();
    }
  }

  // --- Correct: user wants to change the suggestion ---

  // Attempt to re-route with the correction text
  try {
    let originalEvent: SlackEvent;

    try {
      originalEvent = JSON.parse(claimedEventJson) as SlackEvent;
    } catch {
      await redis.hset(
        REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
        threadId,
        claimedEventJson,
      );
      return { handled: false };
    }

    const reroutingTaskDescription = appendAttachmentTextsToPromptText({
      text: stripLeadingSlackProductMention(correctionText),
      attachmentTexts: originalEvent.processedAttachmentTexts,
    });
    const channelName =
      (await slack.getChannelName?.(event.channel)) ?? undefined;

    const routingContext = await buildSlackRoutingContext({
      userId: userMapping.userId,
      taskDescription: reroutingTaskDescription,
      channelName,
      threadMessages: oldPrefill.threadMessages?.map((m) => ({
        text: m.text,
        user: m.user,
      })),
      ...(originalEvent.processedImages?.length
        ? { images: originalEvent.processedImages }
        : {}),
      ...(originalEvent.processedVideoDescriptions?.length
        ? { videoDescriptions: originalEvent.processedVideoDescriptions }
        : {}),
      apiBaseUrl: Env.TRPC_URL,
    });

    // Add the previous suggestion so the router can revise the workspace.
    routingContext.previousSuggestion = {
      workspaceValue: oldPrefill.workspaceValue,
      workspaceDisplayName: oldPrefill.workspaceDisplayName,
      modelId: oldPrefill.modelId,
      modelDisplayName: oldPrefill.modelDisplayName,
    };

    const reRoutingDecision = await routeTask(routingContext);

    if (reRoutingDecision.status === 'platform_answer') {
      await addSlackProcessingReaction({
        slack,
        channel: event.channel,
        messageTs: event.ts,
        reactionName: processingReactionName,
      });

      try {
        await postOrReplaceSlackMessage({
          slack,
          channel: event.channel,
          threadId,
          replaceMessageTs: oldPrefill.confirmMessageTs ?? undefined,
          message: buildPlatformAnswerMessage(reRoutingDecision.result.answer),
        });
      } finally {
        await removeSlackProcessingReaction({
          slack,
          channel: event.channel,
          messageTs: event.ts,
          reactionName: processingReactionName,
        });
      }

      return { handled: true };
    }

    if (reRoutingDecision.status === 'routed') {
      const { result } = reRoutingDecision;
      const newWorkspaceValue = mapRoutingWorkspaceToSelectionValue(
        result.workspace,
      );
      const newAgentName = AGENT_DISPLAY_NAME;

      // Resolve display name for the new workspace.
      const resolved = await resolveWorkspace(newWorkspaceValue);

      const newWorkspaceDisplayName =
        resolved?.workspaceDisplayName ?? newWorkspaceValue;

      // Re-store pending workspace selection (original event).
      await redis.hset(
        REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
        threadId,
        claimedEventJson,
      );

      // Store new confirmation with fresh nonce.
      const correctionNonce = randomUUID();

      const newPrefill: RoutingPrefillData = {
        agentName: newAgentName,
        workspaceOnly: result.workspaceOnly === true,
        workspaceValue: newWorkspaceValue,
        workspaceDisplayName: newWorkspaceDisplayName,
        modelId: result.model?.id ?? oldPrefill.modelId,
        modelDisplayName:
          result.model?.displayName ?? oldPrefill.modelDisplayName,
        workspaceType: result.workspace.type,
        teamId: slackInstallation.teamId,
        teamDomain: slackInstallation.teamDomain ?? oldPrefill.teamDomain,
        slackUserId: event.user,
        channel: event.channel,
        threadMessages: oldPrefill.threadMessages,
        latestOwnBotReplyText: oldPrefill.latestOwnBotReplyText,
        latestOwnBotReplyTs: oldPrefill.latestOwnBotReplyTs,
        confirmNonce: correctionNonce,
        processingReactionName: oldPrefill.processingReactionName,
        reasoning: result.reasoning,
        routingDebug: result.debug,
        routingDurationMs: oldPrefill.routingDurationMs,
        userRoute: `${newAgentName} → ${newWorkspaceDisplayName}`,
      };

      // Replace the old confirmation message with the new routing suggestion
      let confirmMessageTs: string | undefined;
      if (oldPrefill.confirmMessageTs) {
        const updated = await slack.updateMessage({
          channel: oldPrefill.channel,
          ts: oldPrefill.confirmMessageTs,
          message: {
            blocks: buildRoutingConfirmBlocks(
              newWorkspaceDisplayName,
              result.model?.displayName ?? oldPrefill.modelDisplayName,
              {
                threadId,
                confirmNonce: correctionNonce,
              },
            ),
          },
        });
        if (updated) {
          confirmMessageTs = oldPrefill.confirmMessageTs;
        }
      }

      // Fall back to posting a new message if update failed or no old message
      if (!confirmMessageTs) {
        confirmMessageTs = await slack.postMessage({
          channel: event.channel,
          thread_ts: threadId,
          blocks: buildRoutingConfirmBlocks(
            newWorkspaceDisplayName,
            result.model?.displayName ?? oldPrefill.modelDisplayName,
            {
              threadId,
              confirmNonce: correctionNonce,
            },
          ),
        });
      }

      newPrefill.confirmMessageTs = confirmMessageTs;

      await redis.set(prefillKey, JSON.stringify(newPrefill), 'EX', 120);

      console.log(
        `[RoutingCorrection] Re-routed for thread ${threadId}: ` +
          `agent=${newAgentName}, workspace=${newWorkspaceDisplayName}`,
      );

      return {
        handled: true,
        autoConfirmData: {
          threadId,
          confirmNonce: correctionNonce,
          autoConfirmDelayMs: getSlackRoutingAutoConfirmDelayMs(
            result.debug,
            result.workspace.type,
          ),
        },
      };
    }
  } catch (reRouteError) {
    console.error(
      `[RoutingCorrection] Re-routing error: ${reRouteError instanceof Error ? reRouteError.message : String(reRouteError)}`,
    );
  }

  // Re-routing failed – fall back to manual selection UI.
  // Re-store the pending workspace selection so the selection UI works.
  await redis.hset(
    REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
    threadId,
    claimedEventJson,
  );
  await redis.set(
    prefillKey,
    JSON.stringify({
      ...oldPrefill,
      confirmNonce: randomUUID(),
    } satisfies RoutingPrefillData),
    'EX',
    120,
  );

  let originalEvent: SlackEvent;
  try {
    originalEvent = JSON.parse(claimedEventJson);
  } catch {
    console.error(
      '[RoutingCorrection] Failed to parse original event data for fallback',
    );
    return { handled: true };
  }

  console.log(
    `[RoutingCorrection] Re-routing failed for thread ${threadId}, falling back to selection UI`,
  );

  await showTaskConfiguration({
    event: originalEvent,
    slackInstallation,
    userMapping,
    slack,
    skipRouting: true,
    replaceMessageTs: oldPrefill.confirmMessageTs ?? undefined,
  });

  return { handled: true };
}

/**
 * Handles the "OK" button click on a routing confirmation message.
 * Confirms the routing, creates the job, removes the buttons from the
 * confirmation message, and posts the "started" message.
 */
export async function handleRoutingConfirmOk(payload: SlackInteractivePayload) {
  const actionValue =
    payload.actions[0]?.type === 'button'
      ? parseRoutingConfirmActionValue(payload.actions[0].value)
      : null;
  if (!actionValue) {
    console.warn(
      '[RoutingConfirmOk] Missing routing confirmation thread id; ignoring stale or malformed action',
    );
    return;
  }
  const { threadId, confirmNonce } = actionValue;

  const teamId = payload.team.id;
  const prefillJson = await claimRoutingPrefillWithNonce(
    threadId,
    confirmNonce,
    payload.user.id,
  );

  if (!prefillJson) {
    console.warn(
      `[RoutingConfirmOk] Routing prefill missing or unauthorized for thread ${threadId}; ignoring action`,
    );
    return;
  }

  // Claim pending selection atomically
  const originalEventJson = await claimPendingSelection(
    threadId,
    payload.user.id,
  );
  if (!originalEventJson) {
    console.log(
      `[RoutingConfirmOk] Pending selection already consumed for thread ${threadId}, skipping`,
    );
    return;
  }

  const prefill = JSON.parse(prefillJson) as RoutingPrefillData;

  let originalEvent: SlackEvent;
  try {
    originalEvent = JSON.parse(originalEventJson);
  } catch {
    console.error('[RoutingConfirmOk] Failed to parse original event data');
    return;
  }

  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!slackInstallation) {
    console.error('[RoutingConfirmOk] Slack installation not found');
    return;
  }

  const [userMapping] = await db
    .select()
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.slackUserId, prefill.slackUserId),
        eq(slackUserMappings.slackTeamId, teamId),
      ),
    )
    .limit(1);

  if (!userMapping) {
    console.error('[RoutingConfirmOk] User mapping not found');
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const deliveryTracker = new SlackThreadDeliveryTracker(
    originalEvent.channel,
    threadId,
  );

  try {
    const result = await createRunFromPrefill({
      prefill,
      originalEvent,
      threadId,
      userId: userMapping.userId,
      slack,
      deliveryTracker,
    });

    if (!result) {
      console.error(
        '[RoutingConfirmOk] Failed to create task run from prefill',
      );
      return;
    }

    if (result.reusedExistingRun) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: true,
        blocks: buildExistingTaskQueuedBlocks(),
      });
      return;
    }

    await finishRoutedStart({
      runId: result.runId,
      taskId: result.taskId,
      taskDescription: result.taskDescription,
      userId: userMapping.userId,
      initiatingSlackUserId: prefill.slackUserId,
      agentName: prefill.agentName,
      workspaceDisplayName: prefill.workspaceDisplayName,
      workspaceType: prefill.workspaceType,
      workspaceValue: prefill.workspaceValue,
      workspaceOnly: prefill.workspaceOnly,
      channel: prefill.channel,
      threadId,
      teamDomain: prefill.teamDomain,
      reasoning: prefill.reasoning,
      routingDebug: prefill.routingDebug,
      routingDurationMs: prefill.routingDurationMs,
      userRoute: prefill.userRoute,
      existingMessageTs: prefill.confirmMessageTs,
      slack,
    });

    console.log(
      `[RoutingConfirmOk] User confirmed routing for thread ${threadId}: ` +
        `agent=${prefill.agentName}, workspace=${prefill.workspaceDisplayName}`,
    );
  } finally {
    await deliveryTracker.commit();
  }
}

/**
 * Handles the "No" button click on a routing confirmation message.
 * Removes the buttons from the confirmation message and shows the
 * fallback manual selection UI.
 */
export async function handleRoutingRejectNo(payload: SlackInteractivePayload) {
  const actionValue =
    payload.actions[0]?.type === 'button'
      ? parseRoutingConfirmActionValue(payload.actions[0].value)
      : null;
  if (!actionValue) {
    console.warn(
      '[RoutingRejectNo] Missing routing confirmation thread id; ignoring stale or malformed action',
    );
    return;
  }
  const { threadId, confirmNonce } = actionValue;

  const teamId = payload.team.id;
  const redis = getRedis();
  const prefillKey = `${ROUTING_PREFILL_PREFIX}${threadId}`;

  // Claim the old prefill before rewriting it with a fresh nonce so a stale
  // auto-confirm timer cannot consume the old nonce in between.
  const prefillJson = await claimRoutingPrefillWithNonce(
    threadId,
    confirmNonce,
    payload.user.id,
  );
  if (prefillJson) {
    try {
      const prefill = JSON.parse(prefillJson) as RoutingPrefillData;
      await redis.set(
        prefillKey,
        JSON.stringify({
          ...prefill,
          confirmNonce: randomUUID(),
        } satisfies RoutingPrefillData),
        'EX',
        120,
      );
    } catch {
      console.warn(
        `[RoutingRejectNo] Failed to parse routing prefill for thread ${threadId}`,
      );
    }
  } else {
    console.warn(
      `[RoutingRejectNo] Routing prefill missing or unauthorized for thread ${threadId}; ignoring action`,
    );
    return;
  }

  // The pending selection is still in Redis - the fallback UI needs it.
  // Look up the original event from the pending selection to show the selection UI.
  const originalEventJson = await redis.hget(
    REDIS_KEYS.PENDING_WORKSPACE_SELECTIONS,
    threadId,
  );

  if (!originalEventJson) {
    console.error(
      `[RoutingRejectNo] No pending selection found for thread ${threadId}`,
    );
    return;
  }

  let originalEvent: SlackEvent;
  try {
    originalEvent = JSON.parse(originalEventJson);
  } catch {
    console.error('[RoutingRejectNo] Failed to parse original event data');
    return;
  }

  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (!slackInstallation) {
    console.error('[RoutingRejectNo] Slack installation not found');
    return;
  }

  const [userMapping] = await db
    .select()
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.slackUserId, originalEvent.user),
        eq(slackUserMappings.slackTeamId, teamId),
      ),
    )
    .limit(1);

  if (!userMapping) {
    console.error('[RoutingRejectNo] User mapping not found');
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);

  // Replace the routing confirmation with the manual selection UI
  // (skip routing to avoid looping)
  await showTaskConfiguration({
    event: originalEvent,
    slackInstallation,
    userMapping,
    slack,
    skipRouting: true,
    replaceMessageTs: payload.message.ts,
  });

  console.log(
    `[RoutingRejectNo] User rejected routing for thread ${threadId}, replaced routing message with manual selection UI`,
  );
}

/**
 * Handles the "Nevermind" button click on the manual selection UI.
 * Cleans up pending state and replaces the selection message with
 * a cancellation confirmation so the user knows the task was dropped.
 */
export async function handleNevermind(payload: SlackInteractivePayload) {
  const threadId = payload.message.thread_ts || payload.message.ts;

  // Atomically claim the pending selection so that handleTaskConfiguration
  // cannot also consume it (prevents the race where a task starts but the
  // user sees a cancellation message).
  const claimed = await claimPendingSelection(threadId, payload.user.id);

  if (!claimed) {
    // Selection was already consumed by handleTaskConfiguration — a task is
    // in flight.  Don't overwrite the message with a cancellation notice.
    console.log(
      `[handleNevermind] Pending selection already claimed for thread ${threadId}, skipping cancellation`,
    );
    return;
  }

  // Clean up any routing metadata (in case it lingered)
  await getRedis().del(`${ROUTING_PREFILL_PREFIX}${threadId}`);

  // Delete the selection message entirely since the whole thing was a no-op
  await postSlackInteractiveResponse(payload.response_url, {
    delete_original: true,
  });

  console.log(
    `[handleNevermind] User cancelled task selection for thread ${threadId}`,
  );
}

export async function handleRetryFailedTask(
  payload: SlackInteractivePayload,
): Promise<void> {
  const actionValue =
    payload.actions[0]?.type === 'button'
      ? parseRetryFailedTaskActionValue(payload.actions[0].value)
      : null;

  if (!actionValue) {
    console.error('❌ No runId found in retry action');
    return;
  }

  const retryRun = await db.query.taskRuns.findFirst({
    columns: {
      id: true,
      taskId: true,
      payloadKind: true,
      actingUserId: true,
      payload: true,
    },
    where: eq(taskRuns.id, actionValue.runId),
  });

  if (!retryRun) {
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: 'I could not find the failed task to retry.',
    });
    return;
  }

  if (retryRun.payloadKind !== TaskPayloadKind.SlackAppMention) {
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: 'I could not recover the original Slack task details for that retry.',
    });
    return;
  }

  const originalPayload = retryRun.payload as TaskPayload<
    typeof TaskPayloadKind.SlackAppMention
  >;

  if (
    typeof originalPayload.channel !== 'string' ||
    typeof originalPayload.user !== 'string' ||
    typeof originalPayload.text !== 'string' ||
    typeof originalPayload.ts !== 'string' ||
    typeof originalPayload.thread_ts !== 'string' ||
    typeof originalPayload.repo !== 'string'
  ) {
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: 'I could not recover the original Slack task details for that retry.',
    });
    return;
  }

  // Prefer the task's immutable initiator stamp; fall back to the run's
  // acting user for launches that resolved the sender only after start.
  const retryTask = await db.query.tasks.findFirst({
    columns: { initiatorUserId: true },
    where: eq(tasks.id, retryRun.taskId),
  });
  const retryUserId = retryTask?.initiatorUserId ?? retryRun.actingUserId;

  if (typeof retryUserId !== 'string' || retryUserId.length === 0) {
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: 'I could not determine which Roomote user should own that retry.',
    });
    return;
  }

  const retryTeamId = originalPayload.teamId ?? payload.team.id;

  try {
    const [slackInstallation, userMapping] = await Promise.all([
      db.query.slackInstallations.findFirst({
        where: and(
          eq(slackInstallations.teamId, retryTeamId),
          eq(slackInstallations.isActive, true),
        ),
      }),
      db.query.slackUserMappings.findFirst({
        where: and(
          eq(slackUserMappings.userId, retryUserId),
          eq(slackUserMappings.slackTeamId, retryTeamId),
          eq(slackUserMappings.slackUserId, originalPayload.user),
        ),
      }),
    ]);

    if (!slackInstallation) {
      throw new Error('No active Slack installation is available.');
    }

    if (!userMapping) {
      throw new Error(
        'The original Slack user mapping is no longer available.',
      );
    }

    const workspaceValue = originalPayload.environmentId
      ? `${ENV_PREFIX}${originalPayload.environmentId}`
      : `${REPO_PREFIX}${originalPayload.repo}`;
    const resolvedWorkspace = await resolveWorkspace(workspaceValue);

    if (originalPayload.environmentId && !resolvedWorkspace) {
      await postSlackInteractiveResponse(payload.response_url, {
        replace_original: false,
        text: 'The environment used for this task is no longer available. Please send a fresh Slack message in another workspace.',
      });
      return;
    }

    const workspaceDisplayName =
      resolvedWorkspace?.workspaceDisplayName ??
      (originalPayload.repo === ALL_REPOSITORIES
        ? 'all repos'
        : originalPayload.repo);
    const modelId = getHarnessModelOverride(
      originalPayload.harnessModelOverrides,
      'opencode-server',
    );
    const modelDisplayName = modelId
      ? getTaskModelDisplayName(modelId)
      : undefined;

    const taskRun = await startSlackAppMentionTask({
      initiator: {
        kind: 'user',
        externalId: originalPayload.user,
        matchedUserId: retryUserId,
      },
      trigger: 'manual',
      channel: originalPayload.channel,
      teamId: retryTeamId,
      teamDomain:
        getSlackTeamDomainFromTaskPayload(originalPayload) ??
        slackInstallation.teamDomain ??
        undefined,
      slackUserId: originalPayload.user,
      text: originalPayload.text,
      agentPromptText: originalPayload.agentPromptText,
      ackEmoji: originalPayload.ackEmoji,
      completionEmoji: originalPayload.completionEmoji,
      ts: originalPayload.ts,
      threadTs: originalPayload.thread_ts,
      repo: resolvedWorkspace?.repoForPayload ?? originalPayload.repo,
      model: modelId,
      environmentId: resolvedWorkspace?.environmentId,
      readinessMessage: originalPayload.readinessMessage,
      images: originalPayload.images,
      threadMessages: originalPayload.threadMessages,
      latestOwnBotReplyText: originalPayload.latestOwnBotReplyText,
      latestOwnBotReplyTs: originalPayload.latestOwnBotReplyTs,
      webPath: originalPayload.webPath,
      slackConversationUrl:
        getSlackConversationUrlFromTaskPayload(originalPayload) ?? undefined,
      queuedStartedMessage: {
        ts: payload.message.ts,
        agentName: AGENT_DISPLAY_NAME,
        initiatingSlackUserId: originalPayload.user,
        workspaceDisplayName,
        ...(modelDisplayName ? { modelDisplayName } : {}),
        workspaceOnly: false,
      },
    });

    const taskUrl = getSlackStartedMessageFollowUrl({
      taskId: taskRun.taskId,
    });
    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: true,
      blocks: buildStartedBlocks({
        workspaceDisplayName,
        modelDisplayName,
        runId: taskRun.id,
        taskId: taskRun.taskId,
        initiatingSlackUserId: originalPayload.user,
        taskUrl,
        readinessNote: originalPayload.readinessMessage,
      }),
    });

    if (taskRun.id) {
      await setSlackStartedMessageTs(taskRun.id, payload.message.ts, {
        agentName: AGENT_DISPLAY_NAME,
        initiatingSlackUserId: originalPayload.user,
        workspaceDisplayName,
        ...(modelDisplayName ? { modelDisplayName } : {}),
        workspaceOnly: false,
      });
    }

    await getRedis().set(
      `last_workspace:${userMapping.userId}`,
      workspaceValue,
      'EX',
      30 * 24 * 60 * 60,
    );
  } catch (error) {
    console.error(
      `[handleRetryFailedTask] Failed to retry task run ${actionValue.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    await postSlackInteractiveResponse(payload.response_url, {
      replace_original: false,
      text: 'I hit another issue while trying that again. Please retry from a fresh Slack mention.',
    });
  }
}
