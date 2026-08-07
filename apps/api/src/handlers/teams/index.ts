import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import {
  type TeamsActivity,
  type TeamsActivityCommunicationMetadata,
  getTeamsActivityChannelId,
  getTeamsActivityCommunicationMetadata,
  getTeamsActivityImageAttachments,
  getTeamsActivityTeamId,
  getTeamsActivityTenantId,
  isTeamsBotAuthoredActivity,
  isTeamsNativeReactionType,
  isTeamsTaskEntryActivity,
  parseTeamsActivity,
  teamsActivityToQueuedCommunicationMessage,
} from '@roomote/communication/teams-activity';
import { queueCommunicationMessage } from '@roomote/communication/messages';
import {
  buildAccountLinkPromptText,
  buildAccountLinkThreadReplyText,
  buildSnapshotResumeAcknowledgementText,
  buildTaskLaunchAcknowledgementText,
} from '@roomote/communication/chat-messages';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';
import {
  exchangeMicrosoftDelegatedGraphToken,
  extractTeamsGraphHostedContentIds,
  type TeamsGraphMessage,
} from '@roomote/communication/teams-graph-client';
import { Env } from '@roomote/env';
import {
  and,
  authAccounts,
  authUsers,
  db,
  environments,
  eq,
  microsoftAuthUserMappings,
  releaseWorkItemClaim,
  resolveTeamsBotRuntimeCredentials,
  teamsInstallations,
  teamsUserMappings,
  users,
} from '@roomote/db/server';
import { getRedis, withContention } from '@roomote/redis';
import {
  ALL_REPOSITORIES,
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  type TaskSpec,
  type TaskPayload,
  TaskPayloadKind,
  PRODUCT_NAME,
  type QueuedCommunicationMessage,
  isDeploymentReadOnlyError,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import {
  buildTeamsRoutingContext,
  enqueueTask,
  getTaskUrl,
  routeTask,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import { apiLogger } from '../../logging.js';
import { getCallRoomoteViaEmojiConfiguration } from '../call-roomote-via-emoji.js';
import { syncActingUserForInboundMessage } from '../tasks/acting-user-sync.js';
import { findCurrentThreadSuggestionIdByMessage } from '../tasks/current-thread-suggestion-reaction.js';
import {
  attachOutOfBandContextToCommunicationMessage,
  releaseCommunicationOutOfBandClaim,
} from '@roomote/sdk/server/communication';
import { verifyBotFrameworkJwt } from './bot-framework-auth.js';
import {
  findActiveTeamsTaskRun,
  findCompletedTeamsTaskRunWithSnapshot,
} from './find-active-teams-run.js';
import {
  launchClaimedTeamsSuggestion,
  parseTeamsSuggestionStartText,
  resolveAndClaimTeamsSuggestionStart,
  resolveAndClaimTeamsSuggestionReaction,
  type ClaimedTeamsSuggestion,
} from './suggestion-start.js';
import { shouldRouteUnmentionedTeamsThreadReplyToAgent } from './unmentioned-thread-reply.js';

const TEAMS_ACTIVITY_DEDUP_PREFIX = 'teams:activity:';
const TEAMS_ACTIVITY_DEDUP_TTL_SECONDS = 5 * 60;
const TEAMS_AUTH_TOKEN_PREFIX = 'teams:auth:';
const TEAMS_AUTH_TOKEN_TTL_SECONDS = 15 * 60;
const TEAMS_ACCOUNT_LABEL = 'Microsoft Teams account';
const TEAMS_ACCOUNT_LINK_FALLBACK_INSTRUCTION =
  'Please open a personal chat with me and send your request there so I can link your account privately.';
const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';
const CLAIM_PENDING_TEAMS_AUTH_TOKEN_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
redis.call('del', KEYS[1])
return val
`;

type TeamsWorkspaceSelection = {
  environmentId?: string;
  repoForPayload: string;
  workspaceDisplayName: string;
};

type QueuedTeamsCommunicationMessage = QueuedCommunicationMessage & {
  provider: 'teams';
};

type MicrosoftAuthAccount = {
  userId: string;
  accountId: string;
  idToken: string | null;
};

type MicrosoftAuthUserMapping = {
  userId: string;
};

type PendingTeamsAuthToken = {
  activity: TeamsActivity;
  createdAt: string;
};

async function verifyTeamsWebhookAuthorization(input: {
  authorizationHeader: string | undefined;
  activity: TeamsActivity;
}): Promise<{
  ok: boolean;
  status: 401 | 503;
  error: string;
} | null> {
  const { botAppId } = await resolveTeamsBotRuntimeCredentials();

  if (!botAppId) {
    return {
      ok: false,
      status: 503,
      error: 'teams_bot_app_id_not_configured',
    };
  }

  try {
    await verifyBotFrameworkJwt({
      authorizationHeader: input.authorizationHeader,
      botAppId,
      activityServiceUrl: input.activity.serviceUrl,
      activityChannelId: input.activity.channelId,
    });

    return null;
  } catch (error) {
    apiLogger.warn(
      `[teams] Rejected Teams webhook JWT: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return {
      ok: false,
      status: 401,
      error: 'teams_webhook_unauthorized',
    };
  }
}

async function claimTeamsActivity(activityId: string): Promise<boolean> {
  const redis = getRedis();
  const claimed = await redis.set(
    `${TEAMS_ACTIVITY_DEDUP_PREFIX}${activityId}`,
    '1',
    'EX',
    TEAMS_ACTIVITY_DEDUP_TTL_SECONDS,
    'NX',
  );

  return Boolean(claimed);
}

function getTeamsAuthTokenKey(token: string): string {
  return `${TEAMS_AUTH_TOKEN_PREFIX}${token}`;
}

function parsePendingTeamsAuthToken(
  rawValue: string | null,
): PendingTeamsAuthToken | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('activity' in parsed)
    ) {
      return null;
    }

    const parsedObject = parsed as {
      activity: unknown;
      createdAt?: unknown;
    };
    const activity = parsedObject.activity;
    const activityParse = parseTeamsActivity(activity);

    if (!activityParse.success) {
      return null;
    }

    return {
      activity: activityParse.data,
      createdAt:
        typeof parsedObject.createdAt === 'string'
          ? parsedObject.createdAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function createTeamsAuthToken(activity: TeamsActivity): Promise<string> {
  const token = randomUUID();
  const stored = await getRedis().set(
    getTeamsAuthTokenKey(token),
    JSON.stringify({
      activity,
      createdAt: new Date().toISOString(),
    } satisfies PendingTeamsAuthToken),
    'EX',
    TEAMS_AUTH_TOKEN_TTL_SECONDS,
  );

  if (!stored) {
    throw new Error('Unable to create Teams auth token.');
  }

  return token;
}

async function readPendingTeamsAuthToken(
  token: string,
): Promise<PendingTeamsAuthToken | null> {
  const rawValue = await getRedis().get(getTeamsAuthTokenKey(token));

  return parsePendingTeamsAuthToken(rawValue);
}

async function claimPendingTeamsAuthToken(
  token: string,
): Promise<PendingTeamsAuthToken | null> {
  const rawValue = (await getRedis().eval(
    CLAIM_PENDING_TEAMS_AUTH_TOKEN_LUA,
    1,
    getTeamsAuthTokenKey(token),
  )) as string | null;

  return parsePendingTeamsAuthToken(rawValue);
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function parseTeamsActivityTimestamp(value: string | undefined): Date {
  const timestamp = cleanOptionalString(value);

  if (!timestamp) {
    return new Date();
  }

  const parsed = new Date(timestamp);

  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getTeamsInstallationKey(input: {
  tenantId: string;
  teamId?: string;
}): string {
  return input.teamId ? `team:${input.teamId}` : `tenant:${input.tenantId}`;
}

async function persistTeamsInstallationFromActivity(
  activity: TeamsActivity,
): Promise<void> {
  const tenantId = getTeamsActivityTenantId(activity);

  if (!tenantId) {
    apiLogger.warn(
      `[teams] Skipping Teams installation persistence for activity ${activity.id ?? 'unknown'} because tenantId is absent`,
    );
    return;
  }

  const { botAppId } = await resolveTeamsBotRuntimeCredentials();

  if (!botAppId) {
    apiLogger.warn(
      `[teams] Skipping Teams installation persistence for tenant ${tenantId} because no Teams bot app id is configured`,
    );
    return;
  }

  const teamId = getTeamsActivityTeamId(activity);
  const channelId = getTeamsActivityChannelId(activity);
  const now = new Date();

  await db
    .insert(teamsInstallations)
    .values({
      installationKey: getTeamsInstallationKey({ tenantId, teamId }),
      tenantId,
      teamId: teamId ?? null,
      teamName: activity.channelData?.team?.name ?? null,
      channelId: channelId ?? null,
      channelName: activity.channelData?.channel?.name ?? null,
      conversationId: activity.conversation.id,
      conversationType: activity.conversation.conversationType ?? null,
      botAppId,
      botUserId: activity.recipient?.id ?? null,
      botName: activity.recipient?.name ?? null,
      serviceUrl: activity.serviceUrl ?? null,
      isActive: true,
      lastActivityAt: parseTeamsActivityTimestamp(activity.timestamp),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: teamsInstallations.installationKey,
      set: {
        tenantId,
        teamId: teamId ?? null,
        teamName: activity.channelData?.team?.name ?? null,
        channelId: channelId ?? null,
        channelName: activity.channelData?.channel?.name ?? null,
        conversationId: activity.conversation.id,
        conversationType: activity.conversation.conversationType ?? null,
        botAppId,
        botUserId: activity.recipient?.id ?? null,
        botName: activity.recipient?.name ?? null,
        serviceUrl: activity.serviceUrl ?? null,
        isActive: true,
        lastActivityAt: parseTeamsActivityTimestamp(activity.timestamp),
        updatedAt: now,
      },
    });
}

function decodeJwtPayload(token: string | null | undefined) {
  const payload = token?.split('.')[1];

  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown;

    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringClaim(
  claims: Record<string, unknown> | null,
  name: string,
): string | undefined {
  const value = claims?.[name];

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function microsoftAccountMatchesTeamsUser(input: {
  account: MicrosoftAuthAccount;
  tenantId: string;
  teamsAadObjectId: string;
}): boolean {
  const claims = decodeJwtPayload(input.account.idToken);
  const objectId = readStringClaim(claims, 'oid');
  const subject = readStringClaim(claims, 'sub');
  const tenant = readStringClaim(claims, 'tid');
  const tenantMatches = !tenant || tenant === input.tenantId;

  return (
    tenantMatches &&
    (objectId === input.teamsAadObjectId ||
      subject === input.teamsAadObjectId ||
      input.account.accountId === input.teamsAadObjectId)
  );
}

async function findMicrosoftAuthAccountForTeamsUser(input: {
  tenantId: string;
  teamsAadObjectId: string;
}): Promise<MicrosoftAuthUserMapping | null> {
  const mapping = await db.query.microsoftAuthUserMappings.findFirst({
    where: and(
      eq(microsoftAuthUserMappings.microsoftTenantId, input.tenantId),
      eq(
        microsoftAuthUserMappings.microsoftAadObjectId,
        input.teamsAadObjectId,
      ),
    ),
    columns: { userId: true },
  });

  if (mapping) {
    return mapping;
  }

  const accountByProviderId = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.providerId, MICROSOFT_ENTRA_PROVIDER_ID),
      eq(authAccounts.accountId, input.teamsAadObjectId),
    ),
    columns: { userId: true, accountId: true, idToken: true },
  });

  if (
    accountByProviderId &&
    microsoftAccountMatchesTeamsUser({
      account: accountByProviderId,
      tenantId: input.tenantId,
      teamsAadObjectId: input.teamsAadObjectId,
    })
  ) {
    return accountByProviderId;
  }

  return null;
}

async function ensureRoomoteUserForAuthUser(userId: string): Promise<boolean> {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, deletedAt: true },
  });

  if (existingUser && !existingUser.deletedAt) {
    return true;
  }

  if (existingUser?.deletedAt) {
    apiLogger.warn(
      `[teams] Skipping Teams user mapping for Microsoft auth user ${userId} because the Roomote user is deleted`,
    );
    return false;
  }

  const authUser = await db.query.authUsers.findFirst({
    where: eq(authUsers.id, userId),
    columns: { id: true, name: true, email: true, image: true },
  });

  if (!authUser) {
    apiLogger.warn(
      `[teams] Skipping Teams user mapping for Microsoft auth user ${userId} because no auth user row exists`,
    );
    return false;
  }

  await db
    .insert(users)
    .values({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      imageUrl: authUser.image ?? '',
      entity: {
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        imageUrl: authUser.image ?? '',
      },
      metadata: {},
      onboardingCompletedAt: new Date(),
    })
    .onConflictDoNothing({ target: users.id });

  return true;
}

async function linkTeamsUserToMicrosoftAccount(input: {
  tenantId: string;
  teamsUserId?: string;
  teamsAadObjectId: string;
}): Promise<string | null> {
  const account = await findMicrosoftAuthAccountForTeamsUser({
    tenantId: input.tenantId,
    teamsAadObjectId: input.teamsAadObjectId,
  });

  if (!account) {
    return null;
  }

  const userExists = await ensureRoomoteUserForAuthUser(account.userId);

  if (!userExists) {
    return null;
  }

  if (!input.teamsUserId) {
    return account.userId;
  }

  const now = new Date();

  await db
    .insert(teamsUserMappings)
    .values({
      teamsUserId: input.teamsUserId,
      teamsTenantId: input.tenantId,
      teamsAadObjectId: input.teamsAadObjectId,
      userId: account.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [teamsUserMappings.teamsUserId, teamsUserMappings.teamsTenantId],
      set: {
        teamsAadObjectId: input.teamsAadObjectId,
        userId: account.userId,
        updatedAt: now,
      },
    });

  apiLogger.debug(
    `[teams] Linked Teams user ${input.teamsUserId} in tenant ${input.tenantId} to Microsoft auth user ${account.userId}`,
  );

  return account.userId;
}

async function findMappedTeamsUserId(
  activity: TeamsActivity,
): Promise<string | null> {
  const tenantId = getTeamsActivityTenantId(activity);
  const teamsUserId = cleanOptionalString(activity.from?.id);
  const teamsAadObjectId = cleanOptionalString(activity.from?.aadObjectId);

  if (!tenantId || (!teamsUserId && !teamsAadObjectId)) {
    return null;
  }

  if (teamsUserId) {
    const mapping = await db.query.teamsUserMappings.findFirst({
      where: and(
        eq(teamsUserMappings.teamsTenantId, tenantId),
        eq(teamsUserMappings.teamsUserId, teamsUserId),
      ),
      columns: { userId: true },
    });

    if (mapping) {
      return mapping.userId;
    }
  }

  if (!teamsAadObjectId) {
    return null;
  }

  const mapping = await db.query.teamsUserMappings.findFirst({
    where: and(
      eq(teamsUserMappings.teamsTenantId, tenantId),
      eq(teamsUserMappings.teamsAadObjectId, teamsAadObjectId),
    ),
    columns: { userId: true },
  });

  if (mapping) {
    return mapping.userId;
  }

  return linkTeamsUserToMicrosoftAccount({
    tenantId,
    ...(teamsUserId ? { teamsUserId } : {}),
    teamsAadObjectId,
  });
}

async function createTeamsCommunicationProvider(): Promise<TeamsCommunicationProvider | null> {
  return createTeamsCommunicationProviderFromRuntimeCredentials();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function teamsActivityHasHostedContentHint(activity: TeamsActivity): boolean {
  if (extractTeamsGraphHostedContentIds(activity.text ?? '').length > 0) {
    return true;
  }

  for (const rawAttachment of activity.attachments ?? []) {
    const attachment = readRecord(rawAttachment);
    const content = attachment ? attachment.content : undefined;

    if (
      typeof content === 'string' &&
      extractTeamsGraphHostedContentIds(content).length > 0
    ) {
      return true;
    }
  }

  return false;
}

async function createTeamsCommunicationProviderWithGraph(
  userId: string,
): Promise<TeamsCommunicationProvider | null> {
  const graphTokenProvider = createDelegatedTeamsGraphTokenProvider(userId);

  if (!graphTokenProvider) {
    return null;
  }

  return createTeamsCommunicationProviderFromRuntimeCredentials({
    graphTokenProvider,
  });
}

async function resolveTeamsActivityGraphImageDataUrls(input: {
  activity: TeamsActivity;
  userId: string;
}): Promise<string[]> {
  const metadata = getTeamsActivityCommunicationMetadata(input.activity);
  const messageId = metadata.communicationMessageId;

  if (!messageId) {
    return [];
  }

  const provider = await createTeamsCommunicationProviderWithGraph(
    input.userId,
  );

  if (!provider) {
    return [];
  }

  try {
    return await provider.fetchMessageImageDataUrls({
      channelId: metadata.teamsTeamId
        ? (metadata.teamsChannelId ?? metadata.communicationChannelId)
        : metadata.communicationChannelId,
      messageId,
      ...(metadata.communicationServiceUrl
        ? { serviceUrl: metadata.communicationServiceUrl }
        : {}),
      ...(metadata.teamsTeamId ? { teamId: metadata.teamsTeamId } : {}),
      ...(metadata.communicationThreadId
        ? { threadId: metadata.communicationThreadId }
        : {}),
    });
  } catch (error) {
    apiLogger.warn(
      `[teams] Skipping Teams Graph hosted image fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function resolveTeamsActivityImageDataUrls(
  activity: TeamsActivity,
  options: { userId?: string } = {},
): Promise<string[]> {
  const imageAttachments = getTeamsActivityImageAttachments(activity);
  const hasHostedContentHint = teamsActivityHasHostedContentHint(activity);

  if (imageAttachments.length === 0 && !hasHostedContentHint) {
    return [];
  }

  let images: string[] = [];

  if (imageAttachments.length > 0) {
    const provider = await createTeamsCommunicationProvider();

    if (!provider) {
      apiLogger.warn(
        '[teams] Skipping Teams image attachments because bot credentials are not configured',
      );
    } else {
      images = await provider.processImageAttachments(imageAttachments, {
        ...(activity.serviceUrl ? { serviceUrl: activity.serviceUrl } : {}),
      });
    }
  }

  if (
    options.userId &&
    (hasHostedContentHint || images.length < imageAttachments.length)
  ) {
    const graphImages = await resolveTeamsActivityGraphImageDataUrls({
      activity,
      userId: options.userId,
    });
    images = Array.from(new Set([...images, ...graphImages]));
  }

  if (images.length < imageAttachments.length) {
    apiLogger.warn(
      `[teams] Processed ${images.length}/${imageAttachments.length} Teams image attachment(s)`,
    );
  }

  return images;
}

async function attachTeamsActivityImagesToQueuedMessage(
  activity: TeamsActivity,
  queuedMessage: QueuedTeamsCommunicationMessage,
  options: { userId?: string } = {},
): Promise<QueuedTeamsCommunicationMessage> {
  const userId = options.userId ?? queuedMessage.userId;
  const images = await resolveTeamsActivityImageDataUrls(activity, {
    ...(userId ? { userId } : {}),
  });

  return images.length > 0
    ? {
        ...queuedMessage,
        images,
      }
    : queuedMessage;
}

async function postTeamsMessageBestEffort(input: {
  conversationId: string;
  threadId?: string;
  serviceUrl?: string;
  text: string;
}): Promise<void> {
  if (!input.serviceUrl) {
    apiLogger.warn('[teams] Skipping Teams reply because serviceUrl is absent');
    return;
  }

  const provider = await createTeamsCommunicationProvider();
  if (!provider) {
    apiLogger.warn(
      '[teams] Skipping Teams reply because bot credentials are not configured',
    );
    return;
  }

  try {
    await provider.postMessage({
      channelId: input.conversationId,
      serviceUrl: input.serviceUrl,
      ...(input.threadId
        ? { threadId: input.threadId, replyToMessageId: input.threadId }
        : {}),
      text: input.text,
      textFormat: 'markdown',
    });
  } catch (error) {
    apiLogger.warn(
      `[teams] Failed to post Teams reply: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function postTeamsDirectMessageBestEffort(input: {
  botName?: string;
  serviceUrl?: string;
  tenantId?: string;
  text: string;
  teamsUserId?: string;
}): Promise<boolean> {
  if (!input.serviceUrl) {
    apiLogger.warn('[teams] Skipping Teams DM because serviceUrl is absent');
    return false;
  }

  if (!input.tenantId || !input.teamsUserId) {
    apiLogger.warn(
      '[teams] Skipping Teams DM because tenantId or Teams user ID is absent',
    );
    return false;
  }

  const provider = await createTeamsCommunicationProvider();
  if (!provider) {
    apiLogger.warn(
      '[teams] Skipping Teams DM because bot credentials are not configured',
    );
    return false;
  }

  try {
    await provider.postDirectMessage({
      serviceUrl: input.serviceUrl,
      tenantId: input.tenantId,
      userId: input.teamsUserId,
      ...(input.botName ? { botName: input.botName } : {}),
      text: input.text,
      textFormat: 'markdown',
    });
    return true;
  } catch (error) {
    apiLogger.warn(
      `[teams] Failed to post Teams DM: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function buildTeamsAccountLinkPromptText(authToken: string): string {
  const accountLinkUrl = new URL('/api/teams/auth', Env.R_APP_URL);
  accountLinkUrl.searchParams.set('state', authToken);

  return buildAccountLinkPromptText({
    providerName: 'Microsoft Teams',
    productName: PRODUCT_NAME,
    accountLinkUrl: accountLinkUrl.toString(),
  });
}

async function postTeamsAccountLinkPrompt(input: {
  activity: TeamsActivity;
  metadata: TeamsActivityCommunicationMetadata;
}): Promise<void> {
  const authToken = await createTeamsAuthToken(input.activity);
  const promptText = buildTeamsAccountLinkPromptText(authToken);

  if (input.activity.conversation.conversationType === 'personal') {
    await postTeamsMessageBestEffort({
      conversationId: input.metadata.communicationChannelId,
      serviceUrl: input.metadata.communicationServiceUrl,
      text: promptText,
    });
    return;
  }

  const dmPromptSent = await postTeamsDirectMessageBestEffort({
    botName: input.activity.recipient?.name,
    serviceUrl: input.metadata.communicationServiceUrl,
    tenantId: getTeamsActivityTenantId(input.activity),
    teamsUserId: cleanOptionalString(input.activity.from?.id),
    text: promptText,
  });

  await postTeamsMessageBestEffort({
    conversationId: input.metadata.communicationChannelId,
    threadId: input.metadata.communicationThreadId,
    serviceUrl: input.metadata.communicationServiceUrl,
    text: buildAccountLinkThreadReplyText({
      dmPromptSent,
      accountLabel: TEAMS_ACCOUNT_LABEL,
      fallbackInstruction: TEAMS_ACCOUNT_LINK_FALLBACK_INSTRUCTION,
    }),
  });
}

async function resolveTeamsWorkspace(
  workspace: RoutingWorkspace,
): Promise<TeamsWorkspaceSelection | null> {
  if (workspace.type === 'all_repositories') {
    return {
      repoForPayload: ALL_REPOSITORIES,
      workspaceDisplayName: 'all repos',
    };
  }

  const environment = await db.query.environments.findFirst({
    where: eq(environments.id, workspace.id),
    columns: { id: true, name: true, config: true },
  });

  if (!environment) {
    return null;
  }

  const config = environment.config as {
    repositories?: Array<{ repository: string }>;
  };
  const firstRepo = config.repositories?.[0]?.repository;

  if (!firstRepo) {
    return null;
  }

  return {
    environmentId: environment.id,
    repoForPayload: firstRepo,
    workspaceDisplayName: environment.name,
  };
}

/**
 * Result of resuming a Teams task from a snapshot.
 *
 * - `leader`: this caller won the contention lock, enqueued the
 *   SnapshotResume run, and embedded its follow-up message in the job payload.
 *   The caller is responsible for posting the snapshot-resume acknowledgement.
 * - `follower`: another caller already won the lock and enqueued the resume
 *   job. This caller polled for that job and queued its follow-up message to
 *   it. No acknowledgement is posted, since the leader already posted one.
 */
type TeamsSnapshotResumeResult =
  | { mode: 'leader'; runId: number; taskId: string }
  | { mode: 'follower'; runId: number };

async function resumeTeamsTaskFromSnapshot(input: {
  completedRun: Awaited<
    ReturnType<typeof findCompletedTeamsTaskRunWithSnapshot>
  >;
  queuedMessage: QueuedTeamsCommunicationMessage;
  metadata: TeamsActivityCommunicationMetadata;
}): Promise<TeamsSnapshotResumeResult | null> {
  if (!input.completedRun?.snapshotId) {
    return null;
  }

  const completedRun = input.completedRun;
  const sourceSnapshotId = input.completedRun.snapshotId;
  const { queuedMessage, metadata } = input;

  // Two near-simultaneous Teams follow-ups in the same conversation can both
  // pass findCompletedTeamsTaskRunWithSnapshot and enqueue duplicate resume task runs
  // for the same snapshot. Acquire a short-lived distributed lock keyed on the
  // conversation (and thread, when present) so only one caller enqueues the
  // SnapshotResume run; contended callers poll for the leader's resume task run and
  // queue their message to it. Mirrors the Slack withContention and Linear
  // SET NX resume-lock patterns.
  const lockKey = `teams:resume-lock:${metadata.communicationChannelId}:${metadata.communicationThreadId ?? ''}`;

  const result = await withContention<TeamsSnapshotResumeResult>(lockKey, {
    ttlSeconds: 30,
    poll: { intervalMs: 500, maxAttempts: 10 },
    onAcquired: async () => {
      const completedPayload = completedRun.payload as Record<string, unknown>;
      const repo =
        typeof completedPayload.repo === 'string'
          ? completedPayload.repo
          : ALL_REPOSITORIES;
      const environmentId =
        typeof completedPayload.environmentId === 'string'
          ? completedPayload.environmentId
          : undefined;

      // Teams has its own snapshot-resume path and does not go through the
      // shared Discord/Telegram helper, so re-surface out-of-band PR
      // review/status notifications here the same way.
      let resumeQueuedMessage: QueuedTeamsCommunicationMessage = {
        ...queuedMessage,
        provider: 'teams',
      };
      let outOfBandClaim: { messageIds: string[] } | null = null;
      if (completedRun.taskId) {
        const attached = await attachOutOfBandContextToCommunicationMessage({
          taskId: completedRun.taskId,
          provider: 'teams',
          message: resumeQueuedMessage,
        });
        resumeQueuedMessage = {
          ...attached.message,
          provider: 'teams',
        };
        outOfBandClaim = attached.claim;
      }

      const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> =
        {
          repo,
          ...(environmentId ? { environmentId } : {}),
          ...(completedRun.port ? { port: completedRun.port } : {}),
          sourceSnapshotId,
          sourceRunId: completedRun.id,
          queuedCommunicationMessages: [resumeQueuedMessage],
        };

      populateSnapshotResumeCommunicationMetadata(resumePayload, {
        provider: 'teams',
        sourcePayload: completedPayload,
        teamId: metadata.communicationTeamId,
        serviceUrl: metadata.communicationServiceUrl,
        channelId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
        messageId: metadata.communicationMessageId,
      });
      restoreSnapshotResumeVisiblePromptFields(resumePayload, completedPayload);

      // Prefer the queued message sender, then the source run's acting user.
      // No forged fallback: when neither is a real user the resume runs as
      // the deployment service principal.
      const resumeUserId = queuedMessage.userId ?? completedRun.userId ?? null;

      // Resumes never create tasks and never re-attribute; the resuming
      // human becomes the new run's acting user.
      try {
        const resumeLaunch = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.SnapshotResume,
              sourceSnapshotId,
              sourceRunId: completedRun.id,
              payload: resumePayload,
            },
            actingUserId: resumeUserId,
          },
          {
            launchClass: resumeUserId ? 'human' : 'automation',
          },
        );

        apiLogger.debug(
          `✅ Created SnapshotResume task run ${resumeLaunch.id} for Teams conversation ${metadata.communicationChannelId}`,
        );

        return {
          mode: 'leader',
          runId: resumeLaunch.id,
          taskId: resumeLaunch.taskId,
        };
      } catch (error) {
        await releaseCommunicationOutOfBandClaim(outOfBandClaim);
        throw error;
      }
    },
    onContended: async () => {
      // Another handler is already creating the resume task run. Poll for the new
      // active task run so we can queue the follow-up message to the correct
      // (resume) job instead of enqueuing a duplicate.
      const resumeRun = await findActiveTeamsTaskRun({
        conversationId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
      });

      if (!resumeRun) {
        return undefined;
      }

      let followUpMessage: QueuedTeamsCommunicationMessage = queuedMessage;
      let outOfBandClaim: { messageIds: string[] } | null = null;
      // Prefer the completed source task id so notifications recorded against
      // that task still re-surface if the leader resume is still settling.
      const claimTaskId = completedRun.taskId ?? resumeRun.taskId;
      if (claimTaskId) {
        const attached = await attachOutOfBandContextToCommunicationMessage({
          taskId: claimTaskId,
          provider: 'teams',
          message: followUpMessage,
        });
        followUpMessage = {
          ...attached.message,
          provider: 'teams',
        };
        outOfBandClaim = attached.claim;
      }

      try {
        await queueCommunicationMessage('teams', resumeRun.id, followUpMessage);
      } catch (error) {
        await releaseCommunicationOutOfBandClaim(outOfBandClaim);
        throw error;
      }

      apiLogger.debug(
        `[teams] Queued contended Teams follow-up ${queuedMessage.ts} for resume task run ${resumeRun.id}`,
      );

      return { mode: 'follower', runId: resumeRun.id };
    },
  });

  if (result.value === undefined) {
    return null;
  }

  return result.value;
}

/**
 * Builds a delegated Microsoft Graph token provider for the mapped Roomote
 * user by exchanging their linked Entra account's refresh token. Returns null
 * when Microsoft auth is not configured, so history reads degrade instead of
 * failing task entry.
 */
function createDelegatedTeamsGraphTokenProvider(
  userId: string,
): (() => Promise<string>) | null {
  const clientId = Env.R_MICROSOFT_CLIENT_ID;
  const clientSecret = Env.R_MICROSOFT_CLIENT_SECRET;
  const tenantId = Env.R_MICROSOFT_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    return null;
  }

  // Memoize the delegated token per provider instance so the concurrent Graph
  // calls of a single history read share one refresh-token exchange. Entra
  // rotates refresh tokens on each grant, so concurrent exchanges with the
  // same stored token could race and persist a stale rotated token.
  let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;
  let inFlightExchange: Promise<string> | null = null;

  const exchangeToken = async (): Promise<string> => {
    const account = await db.query.authAccounts.findFirst({
      where: and(
        eq(authAccounts.providerId, MICROSOFT_ENTRA_PROVIDER_ID),
        eq(authAccounts.userId, userId),
      ),
      columns: { id: true, refreshToken: true },
    });

    if (!account?.refreshToken) {
      throw new Error(
        `Linked Microsoft account for user ${userId} has no refresh token; re-link Microsoft Teams to enable Graph history reads.`,
      );
    }

    const exchanged = await exchangeMicrosoftDelegatedGraphToken({
      clientId,
      clientSecret,
      tenantId,
      refreshToken: account.refreshToken,
    });

    if (
      exchanged.refreshToken &&
      exchanged.refreshToken !== account.refreshToken
    ) {
      // Entra rotates refresh tokens; persist the newest one best-effort.
      await db
        .update(authAccounts)
        .set({ refreshToken: exchanged.refreshToken, updatedAt: new Date() })
        .where(eq(authAccounts.id, account.id))
        .catch((error: unknown) => {
          apiLogger.warn(
            `[teams] Failed to persist rotated Microsoft refresh token: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }

    cachedToken = {
      accessToken: exchanged.accessToken,
      expiresAtMs: Date.now() + exchanged.expiresInSeconds * 1000 - 60_000,
    };

    return exchanged.accessToken;
  };

  return async () => {
    if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
      return cachedToken.accessToken;
    }

    if (!inFlightExchange) {
      inFlightExchange = exchangeToken().finally(() => {
        inFlightExchange = null;
      });
    }

    return inFlightExchange;
  };
}

/**
 * Best-effort Graph-backed thread history for a Teams channel thread. Returns
 * the raw Graph messages (oldest first) with author identity and mention
 * data, or null when history is unavailable so callers can degrade instead of
 * failing.
 */
async function fetchTeamsThreadGraphMessagesBestEffort(input: {
  metadata: TeamsActivityCommunicationMetadata;
  userId: string;
}): Promise<TeamsGraphMessage[] | null> {
  const { metadata } = input;

  if (
    !metadata.teamsChannelId ||
    !metadata.communicationThreadId ||
    !metadata.teamsTeamId ||
    !metadata.communicationServiceUrl
  ) {
    return null;
  }

  const provider = await createTeamsCommunicationProviderWithGraph(
    input.userId,
  );

  if (!provider) {
    return null;
  }

  try {
    const thread = await provider.fetchThreadGraphMessages({
      channelId: metadata.communicationChannelId,
      messageId: metadata.communicationThreadId,
      serviceUrl: metadata.communicationServiceUrl,
      teamId: metadata.teamsTeamId,
    });

    return thread.messages.length > 0 ? thread.messages : null;
  } catch (error) {
    apiLogger.warn(
      `[teams] Skipping Teams thread history read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Best-effort Graph-backed thread history for routing context. Returns the
 * earlier thread messages (oldest first) for channel-thread mentions, or null
 * when history is unavailable so routing falls back to the single triggering
 * message.
 */
async function fetchTeamsThreadMessagesBestEffort(input: {
  metadata: TeamsActivityCommunicationMetadata;
  userId: string;
}): Promise<Array<{ id: string; user: string; text: string }> | null> {
  const graphMessages = await fetchTeamsThreadGraphMessagesBestEffort(input);

  if (!graphMessages) {
    return null;
  }

  const messages = graphMessages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({
      id: message.id,
      user: message.author,
      text: message.text,
    }));

  return messages.length > 0 ? messages : null;
}

async function startNewTeamsTask(input: {
  activity: TeamsActivity;
  mappedUserId: string;
  queuedMessage: QueuedTeamsCommunicationMessage;
  metadata: TeamsActivityCommunicationMetadata;
  workspaceOverride?: TeamsWorkspaceSelection;
}) {
  const launchUserId = input.mappedUserId;
  const threadHistory = await fetchTeamsThreadMessagesBestEffort({
    metadata: input.metadata,
    userId: launchUserId,
  });
  const triggeringMessage = {
    user: input.queuedMessage.user,
    text: input.queuedMessage.text,
  };
  // Dedupe by activity id: Graph channel message ids match Bot Framework
  // activity ids, while text comparison fails because the queued text has the
  // bot mention stripped and the Graph copy keeps it as `@Bot ...`.
  const historyMessages = (threadHistory ?? []).map(({ user, text }) => ({
    user,
    text,
  }));
  const threadMessages =
    threadHistory &&
    threadHistory.some((message) => message.id === input.queuedMessage.ts)
      ? historyMessages
      : [...historyMessages, triggeringMessage];

  const routingContext = await buildTeamsRoutingContext({
    userId: launchUserId,
    taskDescription: input.queuedMessage.text,
    teamName: input.activity.channelData?.team?.name,
    channelName:
      input.activity.channelData?.channel?.name ??
      input.activity.conversation.name,
    threadMessages,
    ...(input.queuedMessage.images?.length
      ? { images: input.queuedMessage.images }
      : {}),
    apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
  });
  const routingDecision = await routeTask(routingContext);

  if (
    routingDecision.status === 'platform_answer' &&
    !input.workspaceOverride
  ) {
    await postTeamsMessageBestEffort({
      conversationId: input.metadata.communicationChannelId,
      threadId: input.metadata.communicationThreadId,
      serviceUrl: input.metadata.communicationServiceUrl,
      text: routingDecision.result.answer,
    });

    return {
      status: 'replied_inline' as const,
      routingDecision,
    };
  }

  const workspace =
    input.workspaceOverride ??
    (routingDecision.status === 'routed'
      ? await resolveTeamsWorkspace(routingDecision.result.workspace)
      : {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        });

  if (!workspace) {
    throw new Error('Teams task routing selected an unavailable workspace.');
  }

  const task: Extract<TaskSpec, { type: typeof TaskPayloadKind.StandardTask }> =
    {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: workspace.repoForPayload,
        ...(workspace.environmentId
          ? { environmentId: workspace.environmentId }
          : {}),
        description: input.queuedMessage.text,
        ...(input.queuedMessage.images?.length
          ? { images: input.queuedMessage.images }
          : {}),
        ...input.metadata,
      },
    };
  const launchResult = await enqueueTask(
    {
      task,
      initiator: { kind: 'user', userId: launchUserId },
      workflow: 'standard',
      surface: 'teams',
      trigger: 'message',
    },
    {
      launchClass: 'human',
    },
  );

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'teams', campaign: 'teams.thread_start' },
  });

  await postTeamsMessageBestEffort({
    conversationId: input.metadata.communicationChannelId,
    threadId: input.metadata.communicationThreadId,
    serviceUrl: input.metadata.communicationServiceUrl,
    text: buildTaskLaunchAcknowledgementText({
      workspaceDisplayName: workspace.workspaceDisplayName,
      taskUrl,
    }),
  });

  return {
    status: 'started' as const,
    launchResult,
    routingDecision,
    workspace,
  };
}

type ResumePendingTeamsAuthResult =
  | {
      success: true;
      status: 'queued' | 'resumed' | 'started' | 'replied_inline';
      runId?: number;
      taskId?: string;
      taskUrl?: string;
    }
  | {
      success: false;
      error:
        | 'invalid_or_expired_auth_token'
        | 'account_link_required'
        | 'unsupported_activity';
    };

async function resumePendingTeamsAuthToken(
  stateToken: string,
): Promise<ResumePendingTeamsAuthResult> {
  const pending = await readPendingTeamsAuthToken(stateToken);

  if (!pending) {
    return { success: false, error: 'invalid_or_expired_auth_token' };
  }

  const mappedUserId = await findMappedTeamsUserId(pending.activity);

  if (!mappedUserId) {
    return { success: false, error: 'account_link_required' };
  }

  const claimedPending = await claimPendingTeamsAuthToken(stateToken);

  if (!claimedPending) {
    return { success: false, error: 'invalid_or_expired_auth_token' };
  }

  const metadata = getTeamsActivityCommunicationMetadata(
    claimedPending.activity,
  );
  const queuedMessage = teamsActivityToQueuedCommunicationMessage(
    claimedPending.activity,
    { userId: mappedUserId },
  ) as QueuedTeamsCommunicationMessage | null;

  if (!queuedMessage || !isTeamsTaskEntryActivity(claimedPending.activity)) {
    return { success: false, error: 'unsupported_activity' };
  }

  const queuedMessageWithImages =
    await attachTeamsActivityImagesToQueuedMessage(
      claimedPending.activity,
      queuedMessage,
      { userId: mappedUserId },
    );

  const activeRun = await findActiveTeamsTaskRun({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (activeRun) {
    // Trusted pre-queue actor switch; see acting-user-sync.ts.
    await syncActingUserForInboundMessage({
      logContext: 'teams.pendingAuthActivity',
      runId: activeRun.id,
      senderUserId: mappedUserId,
    });
    let authFollowUp: QueuedTeamsCommunicationMessage = queuedMessageWithImages;
    let outOfBandClaim: { messageIds: string[] } | null = null;
    if (activeRun.taskId) {
      const attached = await attachOutOfBandContextToCommunicationMessage({
        taskId: activeRun.taskId,
        provider: 'teams',
        message: authFollowUp,
      });
      authFollowUp = {
        ...attached.message,
        provider: 'teams',
      };
      outOfBandClaim = attached.claim;
    }
    try {
      await queueCommunicationMessage('teams', activeRun.id, authFollowUp);
    } catch (error) {
      await releaseCommunicationOutOfBandClaim(outOfBandClaim);
      throw error;
    }

    apiLogger.debug(
      `[teams] Queued pending Teams auth activity ${queuedMessage.ts} for task run ${activeRun.id}`,
    );

    return {
      success: true,
      status: 'queued',
      runId: activeRun.id,
    };
  }

  const completedRun = await findCompletedTeamsTaskRunWithSnapshot({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (completedRun) {
    try {
      const resumeResult = await resumeTeamsTaskFromSnapshot({
        completedRun,
        queuedMessage: queuedMessageWithImages,
        metadata,
      });

      if (resumeResult) {
        if (resumeResult.mode === 'leader') {
          const taskUrl = getTaskUrl({
            taskId: resumeResult.taskId,
            utm: { source: 'teams', campaign: 'teams.snapshot_resume' },
          });

          await postTeamsMessageBestEffort({
            conversationId: metadata.communicationChannelId,
            threadId: metadata.communicationThreadId,
            serviceUrl: metadata.communicationServiceUrl,
            text: buildSnapshotResumeAcknowledgementText({
              surfaceName: 'Teams thread',
              taskUrl,
            }),
          });

          return {
            success: true,
            status: 'resumed',
            runId: resumeResult.runId,
            taskId: resumeResult.taskId,
            taskUrl,
          };
        }

        return {
          success: true,
          status: 'queued',
          runId: resumeResult.runId,
        };
      }
    } catch (error) {
      if (isDeploymentReadOnlyError(error)) {
        await postTeamsMessageBestEffort({
          conversationId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          serviceUrl: metadata.communicationServiceUrl,
          text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
        });

        return {
          success: true,
          status: 'replied_inline',
        };
      }

      apiLogger.warn(
        `[teams] Failed to resume pending Teams auth task from snapshot for conversation ${metadata.communicationChannelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let launch: Awaited<ReturnType<typeof startNewTeamsTask>>;
  try {
    launch = await startNewTeamsTask({
      activity: claimedPending.activity,
      mappedUserId,
      queuedMessage: queuedMessageWithImages,
      metadata,
    });
  } catch (error) {
    if (isDeploymentReadOnlyError(error)) {
      await postTeamsMessageBestEffort({
        conversationId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
        serviceUrl: metadata.communicationServiceUrl,
        text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
      });

      return {
        success: true,
        status: 'replied_inline',
      };
    }

    throw error;
  }

  if (launch.status === 'replied_inline') {
    return {
      success: true,
      status: 'replied_inline',
    };
  }

  return {
    success: true,
    status: 'started',
    runId: launch.launchResult!.id,
    taskId: launch.launchResult!.taskId,
    taskUrl: getTaskUrl({
      taskId: launch.launchResult!.taskId,
      utm: { source: 'teams', campaign: 'teams.thread_start' },
    }),
  };
}

export const teams = new Hono();

teams.post('/auth/resume', async (c) => {
  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, { status: 400 });
  }

  const stateToken =
    rawBody &&
    typeof rawBody === 'object' &&
    !Array.isArray(rawBody) &&
    typeof (rawBody as { state?: unknown }).state === 'string'
      ? (rawBody as { state: string }).state.trim()
      : '';

  if (!stateToken) {
    return c.json(
      { success: false, error: 'missing_state_token' },
      { status: 400 },
    );
  }

  const result = await resumePendingTeamsAuthToken(stateToken);

  if (result.success) {
    return c.json(result);
  }

  const status =
    result.error === 'account_link_required'
      ? 409
      : result.error === 'invalid_or_expired_auth_token'
        ? 404
        : 400;

  return c.json(result, { status });
});

teams.post('/', async (c) => {
  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseTeamsActivity(rawBody);

  if (!parsed.success) {
    return c.json(
      { ok: false, error: 'invalid_teams_activity' },
      { status: 400 },
    );
  }

  let activity = parsed.data;
  const verificationError = await verifyTeamsWebhookAuthorization({
    authorizationHeader: c.req.header('authorization'),
    activity,
  });

  if (verificationError) {
    apiLogger.warn(
      `[teams] Rejected Teams webhook: ${verificationError.error}`,
    );

    return c.json(
      { ok: false, error: verificationError.error },
      { status: verificationError.status },
    );
  }

  const { botAppId } = await resolveTeamsBotRuntimeCredentials();
  if (
    isTeamsBotAuthoredActivity(activity, {
      ...(botAppId ? { botAppId } : {}),
    })
  ) {
    apiLogger.debug(
      `[teams] Ignoring bot-authored Teams activity ${activity.id ?? 'unknown'}`,
    );
    return c.json({ ok: true, ignored: 'bot_activity' });
  }

  let claimedSuggestionReaction: ClaimedTeamsSuggestion | null = null;
  let suggestionReactionMappedUserId: string | null = null;
  let claimedReactionActivity = false;

  if (activity.type === 'messageReaction') {
    if (activity.id) {
      claimedReactionActivity = await claimTeamsActivity(activity.id);
      if (!claimedReactionActivity) {
        apiLogger.debug(
          `[teams] Skipping duplicate Teams reaction activity ${activity.id}`,
        );
        return c.json({ ok: true, duplicate: true });
      }
    }

    const reactionTargetMessageId = activity.replyToId?.trim();
    const hasLikeReaction = (activity.reactionsAdded ?? []).some(
      (reaction) => reaction.type === 'like',
    );
    if (hasLikeReaction && reactionTargetMessageId) {
      const suggestionId = await findCurrentThreadSuggestionIdByMessage({
        surface: 'teams',
        channelId: activity.conversation.id,
        messageId: reactionTargetMessageId,
      });
      if (suggestionId) {
        suggestionReactionMappedUserId = await findMappedTeamsUserId(activity);
        if (!suggestionReactionMappedUserId) {
          const metadata = getTeamsActivityCommunicationMetadata(activity);
          await postTeamsAccountLinkPrompt({ activity, metadata });
          return c.json({
            ok: true,
            queued: false,
            reason: 'account_link_required',
          });
        }
        const reactionResolution = await resolveAndClaimTeamsSuggestionReaction(
          {
            conversationId: activity.conversation.id,
            messageId: reactionTargetMessageId,
          },
        );
        if (reactionResolution.outcome === 'already_started') {
          const metadata = getTeamsActivityCommunicationMetadata(activity);
          await postTeamsMessageBestEffort({
            conversationId: metadata.communicationChannelId,
            threadId: metadata.communicationThreadId,
            serviceUrl: metadata.communicationServiceUrl,
            text: 'That idea was already started or is no longer available.',
          });
          return c.json({
            ok: true,
            queued: false,
            reason: 'suggestion_already_started',
          });
        }
        if (reactionResolution.outcome === 'claimed') {
          claimedSuggestionReaction = reactionResolution.suggestion;
        }
      }
    }

    let configuration: Awaited<
      ReturnType<typeof getCallRoomoteViaEmojiConfiguration>
    > = null;
    if (!claimedSuggestionReaction) {
      for (const reaction of activity.reactionsAdded ?? []) {
        if (!isTeamsNativeReactionType(reaction.type)) {
          continue;
        }
        configuration = await getCallRoomoteViaEmojiConfiguration(
          reaction.type,
        );
        if (configuration) {
          break;
        }
      }
    }

    if (!configuration && !claimedSuggestionReaction) {
      return c.json({ ok: true, ignored: 'reaction_not_configured' });
    }

    const targetMessageId = activity.replyToId?.trim();
    if (!targetMessageId) {
      return c.json({ ok: true, ignored: 'reaction_target_missing' });
    }

    const mentionName = activity.recipient?.name?.trim() || PRODUCT_NAME;
    const mentionText = `<at>${mentionName}</at>`;
    activity = {
      ...activity,
      type: 'message',
      id: activity.id ?? randomUUID(),
      text: claimedSuggestionReaction
        ? `${mentionText} start suggested task`
        : `${mentionText} ${configuration!.prompt}`,
      replyToId: targetMessageId,
      entities: [
        {
          type: 'mention',
          text: mentionText,
          mentioned: activity.recipient,
        },
      ],
      reactionsAdded: undefined,
    };
  }

  await persistTeamsInstallationFromActivity(activity);
  const mappedUserId =
    suggestionReactionMappedUserId ?? (await findMappedTeamsUserId(activity));
  let queuedMessage = teamsActivityToQueuedCommunicationMessage(activity, {
    ...(mappedUserId ? { userId: mappedUserId } : {}),
  }) as QueuedTeamsCommunicationMessage | null;

  if (!queuedMessage) {
    return c.json({ ok: true, ignored: 'unsupported_activity' });
  }

  const claimed =
    claimedReactionActivity || (await claimTeamsActivity(queuedMessage.ts));

  if (!claimed) {
    apiLogger.debug(
      `[teams] Skipping duplicate Teams activity ${queuedMessage.ts}`,
    );
    return c.json({ ok: true, duplicate: true });
  }

  const metadata = getTeamsActivityCommunicationMetadata(activity);
  if (claimedSuggestionReaction) {
    const workspaceOverride = claimedSuggestionReaction.targetEnvironmentId
      ? await resolveTeamsWorkspace({
          type: 'environment',
          id: claimedSuggestionReaction.targetEnvironmentId,
          name: claimedSuggestionReaction.targetEnvironmentId,
        })
      : undefined;
    if (claimedSuggestionReaction.targetEnvironmentId && !workspaceOverride) {
      await releaseWorkItemClaim(db, {
        id: claimedSuggestionReaction.id,
        claimedAt: claimedSuggestionReaction.launchClaimedAt,
      });
      await postTeamsMessageBestEffort({
        conversationId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
        serviceUrl: metadata.communicationServiceUrl,
        text: 'That idea’s target environment is no longer available.',
      });
      return c.json({
        ok: true,
        queued: false,
        reason: 'suggestion_environment_unavailable',
      });
    }
    const suggestionLaunch = await launchClaimedTeamsSuggestion({
      suggestion: claimedSuggestionReaction,
      launchTask: (promptText) =>
        startNewTeamsTask({
          activity,
          mappedUserId: mappedUserId!,
          queuedMessage: {
            ...queuedMessage!,
            text: promptText,
          } as QueuedTeamsCommunicationMessage,
          metadata,
          ...(workspaceOverride ? { workspaceOverride } : {}),
        }),
      postMessage: (text) =>
        postTeamsMessageBestEffort({
          conversationId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          serviceUrl: metadata.communicationServiceUrl,
          text,
        }),
    });

    return c.json(
      suggestionLaunch.result === 'started'
        ? { ok: true, started: true, runId: suggestionLaunch.runId }
        : {
            ok: true,
            queued: false,
            reason: `suggestion_${suggestionLaunch.result}`,
          },
    );
  }
  const activeRun = await findActiveTeamsTaskRun({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (!activeRun) {
    if (!isTeamsTaskEntryActivity(activity)) {
      // Replying to the bot in a thread it owns needs no @-mention unless
      // somebody else sent a message or was mentioned since the bot's last
      // message. Mirrors the Slack unmentioned thread-reply routing.
      const shouldRouteUnmentionedThreadReply =
        await shouldRouteUnmentionedTeamsThreadReplyToAgent({
          activity,
          metadata,
          mappedUserId,
          botAppId: botAppId ?? null,
          fetchThreadMessages: () =>
            mappedUserId
              ? fetchTeamsThreadGraphMessagesBestEffort({
                  metadata,
                  userId: mappedUserId,
                })
              : Promise.resolve(null),
        });

      if (!shouldRouteUnmentionedThreadReply) {
        apiLogger.debug(
          `[teams] Ignoring Teams message without active task run or task entry signal for conversation ${metadata.communicationChannelId} thread ${metadata.communicationThreadId ?? 'unknown'}`,
        );

        return c.json({ ok: true, queued: false, reason: 'not_task_entry' });
      }
    }

    if (!mappedUserId) {
      await postTeamsAccountLinkPrompt({ activity, metadata });

      return c.json({
        ok: true,
        queued: false,
        reason: 'account_link_required',
      });
    }

    // Structured "start idea N" hook for the posted suggestion lists. Matches
    // are driven through the shared work-item claim state machine (claim ->
    // launch -> fenced finalize/release) like the Slack reaction and Telegram
    // button surfaces; anything that does not parse, or a conversation with no
    // tracked suggestion cards, falls through to normal task entry unchanged.
    // This runs before the snapshot resume so a suggestion start is never
    // swallowed as a follow-up to the conversation's previous task.
    const suggestionIdeaNumber = parseTeamsSuggestionStartText(
      queuedMessage.text,
    );

    if (suggestionIdeaNumber !== null) {
      const resolution = await resolveAndClaimTeamsSuggestionStart({
        conversationId: metadata.communicationChannelId,
        ...(metadata.communicationThreadId
          ? { threadId: metadata.communicationThreadId }
          : {}),
        ideaNumber: suggestionIdeaNumber,
      });

      if (resolution.outcome === 'not_found') {
        await postTeamsMessageBestEffort({
          conversationId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          serviceUrl: metadata.communicationServiceUrl,
          text: `I couldn't find idea ${suggestionIdeaNumber} — the latest suggestions list has ${resolution.ideaCount} idea${resolution.ideaCount === 1 ? '' : 's'}.`,
        });

        return c.json({
          ok: true,
          queued: false,
          reason: 'suggestion_not_found',
        });
      }

      if (resolution.outcome === 'already_started') {
        await postTeamsMessageBestEffort({
          conversationId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          serviceUrl: metadata.communicationServiceUrl,
          text: `"${resolution.title}" was already started or is no longer available.`,
        });

        return c.json({
          ok: true,
          queued: false,
          reason: 'suggestion_already_started',
        });
      }

      if (resolution.outcome === 'claimed') {
        const workspaceOverride = resolution.suggestion.targetEnvironmentId
          ? await resolveTeamsWorkspace({
              type: 'environment',
              id: resolution.suggestion.targetEnvironmentId,
              name: resolution.suggestion.targetEnvironmentId,
            })
          : undefined;
        if (resolution.suggestion.targetEnvironmentId && !workspaceOverride) {
          await releaseWorkItemClaim(db, {
            id: resolution.suggestion.id,
            claimedAt: resolution.suggestion.launchClaimedAt,
          });
          await postTeamsMessageBestEffort({
            conversationId: metadata.communicationChannelId,
            threadId: metadata.communicationThreadId,
            serviceUrl: metadata.communicationServiceUrl,
            text: 'That idea’s target environment is no longer available.',
          });
          return c.json({
            ok: true,
            queued: false,
            reason: 'suggestion_environment_unavailable',
          });
        }
        const suggestionLaunch = await launchClaimedTeamsSuggestion({
          suggestion: resolution.suggestion,
          launchTask: (promptText) =>
            startNewTeamsTask({
              activity,
              mappedUserId,
              queuedMessage: { ...queuedMessage!, text: promptText },
              metadata,
              ...(workspaceOverride ? { workspaceOverride } : {}),
            }),
          postMessage: (text) =>
            postTeamsMessageBestEffort({
              conversationId: metadata.communicationChannelId,
              threadId: metadata.communicationThreadId,
              serviceUrl: metadata.communicationServiceUrl,
              text,
            }),
        });

        return c.json(
          suggestionLaunch.result === 'started'
            ? {
                ok: true,
                started: true,
                runId: suggestionLaunch.runId,
              }
            : {
                ok: true,
                queued: false,
                reason: `suggestion_${suggestionLaunch.result}`,
              },
        );
      }

      // outcome === 'no_cards': fall through to normal task entry.
    }

    queuedMessage = await attachTeamsActivityImagesToQueuedMessage(
      activity,
      queuedMessage,
      { userId: mappedUserId },
    );

    const completedRun = await findCompletedTeamsTaskRunWithSnapshot({
      conversationId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
    });

    if (completedRun) {
      try {
        const resumeResult = await resumeTeamsTaskFromSnapshot({
          completedRun,
          queuedMessage,
          metadata,
        });

        if (resumeResult) {
          if (resumeResult.mode === 'leader') {
            const taskUrl = getTaskUrl({
              taskId: resumeResult.taskId,
              utm: { source: 'teams', campaign: 'teams.snapshot_resume' },
            });

            await postTeamsMessageBestEffort({
              conversationId: metadata.communicationChannelId,
              threadId: metadata.communicationThreadId,
              serviceUrl: metadata.communicationServiceUrl,
              text: buildSnapshotResumeAcknowledgementText({
                surfaceName: 'Teams thread',
                taskUrl,
              }),
            });

            return c.json({
              ok: true,
              resumed: true,
              runId: resumeResult.runId,
            });
          }

          return c.json({
            ok: true,
            queued: true,
            runId: resumeResult.runId,
          });
        }
      } catch (error) {
        if (isDeploymentReadOnlyError(error)) {
          await postTeamsMessageBestEffort({
            conversationId: metadata.communicationChannelId,
            threadId: metadata.communicationThreadId,
            serviceUrl: metadata.communicationServiceUrl,
            text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
          });

          return c.json({
            ok: true,
            queued: false,
            repliedInline: true,
          });
        }

        apiLogger.warn(
          `[teams] Failed to resume Teams task from snapshot for conversation ${metadata.communicationChannelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let launch: Awaited<ReturnType<typeof startNewTeamsTask>>;
    try {
      launch = await startNewTeamsTask({
        activity,
        mappedUserId,
        queuedMessage,
        metadata,
      });
    } catch (error) {
      if (isDeploymentReadOnlyError(error)) {
        await postTeamsMessageBestEffort({
          conversationId: metadata.communicationChannelId,
          threadId: metadata.communicationThreadId,
          serviceUrl: metadata.communicationServiceUrl,
          text: MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
        });

        return c.json({
          ok: true,
          queued: false,
          repliedInline: true,
        });
      }

      throw error;
    }

    if (launch.status === 'replied_inline') {
      return c.json({
        ok: true,
        queued: false,
        repliedInline: true,
      });
    }

    return c.json({
      ok: true,
      started: true,
      runId: launch.launchResult!.id,
    });
  }

  queuedMessage = await attachTeamsActivityImagesToQueuedMessage(
    activity,
    queuedMessage,
    { ...(mappedUserId ? { userId: mappedUserId } : {}) },
  );

  // Trusted pre-queue actor switch; see acting-user-sync.ts. The worker only
  // runs the queued turn as this sender if the server actor already matches.
  await syncActingUserForInboundMessage({
    logContext: 'teams.activeRunMessage',
    runId: activeRun.id,
    senderUserId: mappedUserId,
  });

  if (mappedUserId && queuedMessage.text?.trim()) {
    const { tryHandleTeamsRequestUserInputMessage } =
      await import('./request-user-input.js');
    const handled = await tryHandleTeamsRequestUserInputMessage({
      activeRunId: activeRun.id,
      userId: mappedUserId,
      text: queuedMessage.text,
      conversationId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
      serviceUrl: metadata.communicationServiceUrl ?? null,
    });
    if (handled) {
      return c.json({
        ok: true,
        queued: true,
        runId: activeRun.id,
        requestUserInput: true,
      });
    }
  }

  let activeFollowUp: QueuedTeamsCommunicationMessage = queuedMessage;
  let outOfBandClaim: { messageIds: string[] } | null = null;
  if (activeRun.taskId) {
    const attached = await attachOutOfBandContextToCommunicationMessage({
      taskId: activeRun.taskId,
      provider: 'teams',
      message: activeFollowUp,
    });
    activeFollowUp = {
      ...attached.message,
      provider: 'teams',
    };
    outOfBandClaim = attached.claim;
  }
  try {
    await queueCommunicationMessage('teams', activeRun.id, activeFollowUp);
  } catch (error) {
    await releaseCommunicationOutOfBandClaim(outOfBandClaim);
    throw error;
  }

  apiLogger.debug(
    `[teams] Queued Teams activity ${queuedMessage.ts} for task run ${activeRun.id}`,
  );

  return c.json({ ok: true, queued: true, runId: activeRun.id });
});
