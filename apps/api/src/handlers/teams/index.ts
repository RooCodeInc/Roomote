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
import { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
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
  resolveTeamsBotRuntimeCredentials,
  teamsInstallations,
  teamsUserMappings,
  users,
} from '@roomote/db/server';
import { getRedis, withContention } from '@roomote/redis';
import {
  ALL_REPOSITORIES,
  type CloudTask,
  type CloudTaskPayload,
  CloudTaskType,
  PRODUCT_NAME,
  type QueuedCommunicationMessage,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import {
  buildTeamsRoutingContext,
  enqueueCloudTask,
  getTaskUrl,
  routeTask,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import { apiLogger } from '../../logging.js';
import { verifyBotFrameworkJwt } from './bot-framework-auth.js';
import {
  findActiveTeamsJob,
  findCompletedTeamsJobWithSnapshot,
} from './find-active-teams-job.js';
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
  const credentials = await resolveTeamsBotRuntimeCredentials();

  if (!credentials.botAppId || !credentials.botAppPassword) {
    return null;
  }

  const graphTokenProvider = createDelegatedTeamsGraphTokenProvider(userId);

  if (!graphTokenProvider) {
    return null;
  }

  return new TeamsCommunicationProvider({
    appId: credentials.botAppId,
    appPassword: credentials.botAppPassword,
    ...(credentials.botTenantId ? { tenantId: credentials.botTenantId } : {}),
    ...(credentials.botTokenEndpoint
      ? { tokenEndpoint: credentials.botTokenEndpoint }
      : {}),
    ...(credentials.botOauthScope
      ? { oauthScope: credentials.botOauthScope }
      : {}),
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
  const accountLinkUrl = new URL('/api/teams/auth', Env.ROOMOTE_APP_URL);
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
 *   SnapshotResume job, and embedded its follow-up message in the job payload.
 *   The caller is responsible for posting the snapshot-resume acknowledgement.
 * - `follower`: another caller already won the lock and enqueued the resume
 *   job. This caller polled for that job and queued its follow-up message to
 *   it. No acknowledgement is posted, since the leader already posted one.
 */
type TeamsSnapshotResumeResult =
  | { mode: 'leader'; cloudJobId: number; taskId: string }
  | { mode: 'follower'; cloudJobId: number };

async function resumeTeamsTaskFromSnapshot(input: {
  completedJob: Awaited<ReturnType<typeof findCompletedTeamsJobWithSnapshot>>;
  queuedMessage: QueuedTeamsCommunicationMessage;
  metadata: TeamsActivityCommunicationMetadata;
}): Promise<TeamsSnapshotResumeResult | null> {
  if (!input.completedJob?.snapshotId) {
    return null;
  }

  const completedJob = input.completedJob;
  const sourceSnapshotId = input.completedJob.snapshotId;
  const { queuedMessage, metadata } = input;

  // Two near-simultaneous Teams follow-ups in the same conversation can both
  // pass findCompletedTeamsJobWithSnapshot and enqueue duplicate resume jobs
  // for the same snapshot. Acquire a short-lived distributed lock keyed on the
  // conversation (and thread, when present) so only one caller enqueues the
  // SnapshotResume job; contended callers poll for the leader's resume job and
  // queue their message to it. Mirrors the Slack withContention and Linear
  // SET NX resume-lock patterns.
  const lockKey = `teams:resume-lock:${metadata.communicationChannelId}:${metadata.communicationThreadId ?? ''}`;

  const result = await withContention<TeamsSnapshotResumeResult>(lockKey, {
    ttlSeconds: 30,
    poll: { intervalMs: 500, maxAttempts: 10 },
    onAcquired: async () => {
      const completedPayload = completedJob.payload as Record<string, unknown>;
      const repo =
        typeof completedPayload.repo === 'string'
          ? completedPayload.repo
          : ALL_REPOSITORIES;
      const environmentId =
        typeof completedPayload.environmentId === 'string'
          ? completedPayload.environmentId
          : undefined;
      const resumePayload: CloudTaskPayload<CloudTaskType.SnapshotResume> = {
        repo,
        ...(environmentId ? { environmentId } : {}),
        ...(completedJob.port ? { port: completedJob.port } : {}),
        sourceSnapshotId,
        sourceCloudJobId: completedJob.id,
        queuedCommunicationMessages: [queuedMessage],
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

      // Prefer the queued message sender, then the completed job's owner. No
      // forged fallback: when neither is a real user the resume runs as the
      // deployment service principal via an automation launch.
      const resumeUserId = queuedMessage.userId ?? completedJob.userId ?? null;

      const resumeLaunch = await enqueueCloudTask(
        {
          type: CloudTaskType.SnapshotResume,
          userId: resumeUserId,
          sourceSnapshotId,
          sourceCloudJobId: completedJob.id,
          payload: resumePayload,
        },
        {
          launchClass: resumeUserId ? 'human' : 'automation',
        },
      );

      apiLogger.debug(
        `✅ Created SnapshotResume cloud job ${resumeLaunch.id} for Teams conversation ${metadata.communicationChannelId}`,
      );

      return {
        mode: 'leader',
        cloudJobId: resumeLaunch.id,
        taskId: resumeLaunch.taskId,
      };
    },
    onContended: async () => {
      // Another handler is already creating the resume job. Poll for the new
      // active job so we can queue the follow-up message to the correct
      // (resume) job instead of enqueuing a duplicate.
      const resumeJob = await findActiveTeamsJob({
        conversationId: metadata.communicationChannelId,
        threadId: metadata.communicationThreadId,
      });

      if (!resumeJob) {
        return undefined;
      }

      await queueCommunicationMessage('teams', resumeJob.id, queuedMessage);

      apiLogger.debug(
        `[teams] Queued contended Teams follow-up ${queuedMessage.ts} for resume cloud job ${resumeJob.id}`,
      );

      return { mode: 'follower', cloudJobId: resumeJob.id };
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
  const clientId = Env.ROOMOTE_AUTH_MICROSOFT_CLIENT_ID;
  const clientSecret = Env.ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET;
  const tenantId = Env.ROOMOTE_AUTH_MICROSOFT_TENANT_ID;

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
    apiBaseUrl: Env.TRPC_URL ?? Env.ROOMOTE_APP_URL,
  });
  const routingDecision = await routeTask(routingContext);

  if (routingDecision.status === 'platform_answer') {
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
    routingDecision.status === 'routed'
      ? await resolveTeamsWorkspace(routingDecision.result.workspace)
      : {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        };

  if (!workspace) {
    throw new Error('Teams task routing selected an unavailable workspace.');
  }

  const task: Extract<CloudTask, { type: CloudTaskType.StandardTask }> = {
    type: CloudTaskType.StandardTask,
    userId: launchUserId,
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
  const launchResult = await enqueueCloudTask(task, {
    launchClass: 'human',
  });

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
      cloudJobId?: number;
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

  const activeJob = await findActiveTeamsJob({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (activeJob) {
    await queueCommunicationMessage(
      'teams',
      activeJob.id,
      queuedMessageWithImages,
    );

    apiLogger.debug(
      `[teams] Queued pending Teams auth activity ${queuedMessage.ts} for cloud job ${activeJob.id}`,
    );

    return {
      success: true,
      status: 'queued',
      cloudJobId: activeJob.id,
    };
  }

  const completedJob = await findCompletedTeamsJobWithSnapshot({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (completedJob) {
    try {
      const resumeResult = await resumeTeamsTaskFromSnapshot({
        completedJob,
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
            cloudJobId: resumeResult.cloudJobId,
            taskId: resumeResult.taskId,
            taskUrl,
          };
        }

        return {
          success: true,
          status: 'queued',
          cloudJobId: resumeResult.cloudJobId,
        };
      }
    } catch (error) {
      apiLogger.warn(
        `[teams] Failed to resume pending Teams auth task from snapshot for conversation ${metadata.communicationChannelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const launch = await startNewTeamsTask({
    activity: claimedPending.activity,
    mappedUserId,
    queuedMessage: queuedMessageWithImages,
    metadata,
  });

  if (launch.status === 'replied_inline') {
    return {
      success: true,
      status: 'replied_inline',
    };
  }

  return {
    success: true,
    status: 'started',
    cloudJobId: launch.launchResult!.id,
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

  const activity = parsed.data;
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

  await persistTeamsInstallationFromActivity(activity);

  const mappedUserId = await findMappedTeamsUserId(activity);
  let queuedMessage = teamsActivityToQueuedCommunicationMessage(activity, {
    ...(mappedUserId ? { userId: mappedUserId } : {}),
  }) as QueuedTeamsCommunicationMessage | null;

  if (!queuedMessage) {
    return c.json({ ok: true, ignored: 'unsupported_activity' });
  }

  const claimed = await claimTeamsActivity(queuedMessage.ts);

  if (!claimed) {
    apiLogger.debug(
      `[teams] Skipping duplicate Teams activity ${queuedMessage.ts}`,
    );
    return c.json({ ok: true, duplicate: true });
  }

  const metadata = getTeamsActivityCommunicationMetadata(activity);
  const activeJob = await findActiveTeamsJob({
    conversationId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
  });

  if (!activeJob) {
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
          `[teams] Ignoring Teams message without active job or task entry signal for conversation ${metadata.communicationChannelId} thread ${metadata.communicationThreadId ?? 'unknown'}`,
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

    queuedMessage = await attachTeamsActivityImagesToQueuedMessage(
      activity,
      queuedMessage,
      { userId: mappedUserId },
    );

    const completedJob = await findCompletedTeamsJobWithSnapshot({
      conversationId: metadata.communicationChannelId,
      threadId: metadata.communicationThreadId,
    });

    if (completedJob) {
      try {
        const resumeResult = await resumeTeamsTaskFromSnapshot({
          completedJob,
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
              cloudJobId: resumeResult.cloudJobId,
            });
          }

          return c.json({
            ok: true,
            queued: true,
            cloudJobId: resumeResult.cloudJobId,
          });
        }
      } catch (error) {
        apiLogger.warn(
          `[teams] Failed to resume Teams task from snapshot for conversation ${metadata.communicationChannelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const launch = await startNewTeamsTask({
      activity,
      mappedUserId,
      queuedMessage,
      metadata,
    });

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
      cloudJobId: launch.launchResult!.id,
    });
  }

  queuedMessage = await attachTeamsActivityImagesToQueuedMessage(
    activity,
    queuedMessage,
    { ...(mappedUserId ? { userId: mappedUserId } : {}) },
  );

  await queueCommunicationMessage('teams', activeJob.id, queuedMessage);

  apiLogger.debug(
    `[teams] Queued Teams activity ${queuedMessage.ts} for cloud job ${activeJob.id}`,
  );

  return c.json({ ok: true, queued: true, cloudJobId: activeJob.id });
});
