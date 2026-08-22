import {
  SlackNotifier,
  shouldResumeSlackAuthThread,
  showTaskConfiguration,
} from '@roomote/slack';
import {
  enqueueSlackAccountLinkEducation,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';
import { PRODUCT_NAME } from '@roomote/types';
import {
  type SlackAuthToken,
  type SlackInstallation,
  type SlackUserMapping,
  and,
  db,
  desc,
  eq,
  gt,
  resolveEffectiveDeploymentEnvVars,
  slackAuthTokens,
  slackInstallations,
  slackUserMappings,
  users,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { getSlackRedirectUri } from '@/lib/server/slack-redirect-uri';
import { syncUser } from '@/lib/server/sync-internal';
import { buildSlackInstallUrl } from '@/lib/slack-install-url';
import {
  createSignedSlackInstallState,
  createSignedSlackLinkAccountState,
  decodeSlackOAuthState,
} from '@/lib/server/slack-oauth-state';

export { createSlackAppFromManifestCommand } from './create-app-from-manifest';
export { updateSlackAppManifestCommand } from './update-app-manifest';

interface SlackOAuthResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    id: string;
    name: string;
    domain?: string;
  };
  enterprise?: {
    id: string;
    name: string;
  };
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
  error?: string;
}

interface SlackOIDCTokenResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
}

interface SlackOIDCUserInfoResponse {
  ok: boolean;
  sub?: string;
  'https://slack.com/team_id'?: string;
  'https://slack.com/team_name'?: string;
  name?: string;
  email?: string;
  error?: string;
}

function getUnauthorizedResult() {
  return {
    success: false as const,
    error: 'Unauthorized',
  };
}

function assertAdminResult(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  return null;
}

async function resolveSlackOAuthConfig() {
  const deploymentEnvVars = await resolveEffectiveDeploymentEnvVars();
  const readConfiguredValue = (key: string) => {
    const runtimeValue = process.env[key]?.trim();

    if (runtimeValue) {
      return runtimeValue;
    }

    const deploymentValue = deploymentEnvVars[key]?.trim();

    if (deploymentValue) {
      return deploymentValue;
    }

    return '';
  };

  return {
    clientId: readConfiguredValue('R_SLACK_CLIENT_ID'),
    clientSecret: readConfiguredValue('R_SLACK_CLIENT_SECRET'),
    appId: readConfiguredValue('SLACK_APP_ID'),
  };
}

async function refreshSlackInstallationMemberSnapshot(params: {
  botAccessToken: string;
  teamId: string;
}) {
  const slack = new SlackNotifier(params.botAccessToken);
  const memberCountSnapshot = await slack.getWorkspaceMemberCount();

  if (memberCountSnapshot === null) {
    return;
  }

  await db
    .update(slackInstallations)
    .set({
      memberCountSnapshot,
      memberCountSnapshotAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(slackInstallations.teamId, params.teamId));
}

async function resolveSlackBotDisplayMetadata(params: {
  botAccessToken: string;
  botUserId: string;
}): Promise<{ botName: string | null; appName: string | null }> {
  try {
    const slack = new SlackNotifier(params.botAccessToken);
    const botName = await slack.getUserDisplayName(params.botUserId);

    return {
      botName,
      appName: null,
    };
  } catch (error) {
    console.error(
      '[exchangeSlackOAuthCodeCommand] Failed to resolve Slack bot display metadata:',
      error,
    );
    return {
      botName: null,
      appName: null,
    };
  }
}

async function ensureSlackMappingUserExists(userId: string) {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true },
  });

  if (existingUser) {
    return;
  }

  await syncUser(userId, { throwOnError: true });

  const syncedUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true },
  });

  if (!syncedUser) {
    throw new Error('Unable to sync user before linking Slack account');
  }
}

async function sendSlackPostConnectDm({
  slack,
  authToken,
  slackInstallation,
  userMapping,
  resumedOriginalThread,
}: {
  slack: SlackNotifier;
  authToken: SlackAuthToken;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  resumedOriginalThread: boolean;
}) {
  const dmChannelId = await slack.openConversation(authToken.slackUserId);
  if (!dmChannelId) {
    return;
  }

  const text = resumedOriginalThread
    ? `Your Slack account is now connected to ${PRODUCT_NAME}. I'll continue in your original Slack thread.`
    : `Your Slack account is now connected to ${PRODUCT_NAME}. Return to the original Slack thread and try again.`;

  const messageTs = await slack.postMessage({
    channel: dmChannelId,
    text,
  });

  if (!messageTs) {
    return;
  }

  await recordSlackConversationMessageBestEffort({
    logContext: 'slack.handleSlackAuthentication',
    subjectUserId: userMapping.userId,
    slackTeamId: slackInstallation.teamId,
    subjectSlackUserId: userMapping.slackUserId,
    slackChannelId: dmChannelId,
    conversationKind: 'dm',
    messageTs,
    direction: 'outbound',
    authorKind: 'roomote',
    source: 'post_connect_dm',
    text,
  });
}

type SlackUserMappingUpsertStatus = 'created' | 'relinked' | 'unchanged';

async function enqueueSlackAccountLinkEducationIfNeeded({
  status,
  slackTeamId,
  slackUserId,
  userId,
  mappingLinkedAt,
  logContext,
}: {
  status: SlackUserMappingUpsertStatus;
  slackTeamId: string;
  slackUserId: string;
  userId: string;
  mappingLinkedAt: Date;
  logContext: string;
}) {
  if (status === 'unchanged') {
    return;
  }

  try {
    await enqueueSlackAccountLinkEducation({
      slackTeamId,
      slackUserId,
      userId,
      mappingLinkedAt,
    });
  } catch (error) {
    console.error(
      `[${logContext}] Failed to enqueue Slack account link education DM:`,
      error,
    );
  }
}

async function upsertSlackUserMapping({
  slackUserId,
  slackTeamId,
  userId,
}: {
  slackUserId: string;
  slackTeamId: string;
  userId: string;
}): Promise<{
  userMapping: SlackUserMapping;
  status: SlackUserMappingUpsertStatus;
}> {
  let userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, slackUserId),
      eq(slackUserMappings.slackTeamId, slackTeamId),
    ),
  });
  let status: SlackUserMappingUpsertStatus = 'unchanged';

  if (!userMapping) {
    await db.insert(slackUserMappings).values({
      slackUserId,
      slackTeamId,
      userId,
    });
    status = 'created';
  } else if (userMapping.userId !== userId) {
    // Refuse re-link of existing mappings owned by another user. Silent
    // takeover enables OAuth CSRF / account takeover when a victim completes
    // an attacker's callback URL.
    throw new Error(
      'This Slack account is already linked to another Roomote user. Unlink it there before reconnecting.',
    );
  }

  userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, slackUserId),
      eq(slackUserMappings.slackTeamId, slackTeamId),
    ),
  });

  if (!userMapping) {
    throw new Error('Unable to connect Slack account');
  }

  return { userMapping, status };
}

async function handleSlackAuthentication({
  userId,
  authToken,
}: {
  userId: string;
  authToken: SlackAuthToken;
}) {
  await bootstrapWebRuntimeEnv();
  await ensureSlackMappingUserExists(userId);

  const { userMapping, status } = await upsertSlackUserMapping({
    slackUserId: authToken.slackUserId,
    slackTeamId: authToken.slackTeamId,
    userId,
  });

  await enqueueSlackAccountLinkEducationIfNeeded({
    status,
    slackTeamId: authToken.slackTeamId,
    slackUserId: authToken.slackUserId,
    userId,
    mappingLinkedAt: userMapping.updatedAt,
    logContext: 'handleSlackAuthentication',
  });

  const [slackInstallation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, authToken.slackTeamId))
    .limit(1);

  if (!slackInstallation) {
    throw new Error('Slack installation not found');
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const resumedOriginalThread = shouldResumeSlackAuthThread(
    authToken.originalText,
  );

  if (resumedOriginalThread) {
    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: authToken.channel,
        user: authToken.slackUserId,
        text: authToken.originalText,
        ts: authToken.threadTs,
        thread_ts: undefined,
      },
      slackInstallation,
      userMapping,
      slack,
    });
  }

  try {
    await sendSlackPostConnectDm({
      slack,
      authToken,
      slackInstallation,
      userMapping,
      resumedOriginalThread,
    });
  } catch (error) {
    console.error(
      '[handleSlackAuthentication] Failed to send post-connect DM:',
      error,
    );
  }
}

export async function exchangeSlackOAuthCodeCommand(
  auth: UserAuthSuccess,
  input: {
    code: string;
    state: string;
  },
): Promise<
  | { success: true; installation: SlackInstallation }
  | { success: false; error: string }
> {
  try {
    const adminError = assertAdminResult(auth);
    if (adminError) {
      return adminError;
    }
    const slackOAuthConfig = await resolveSlackOAuthConfig();

    const state = await decodeSlackOAuthState(input.state);
    if (!state || state.mode !== 'install') {
      return { success: false, error: 'Invalid Slack OAuth state' };
    }

    const params = new URLSearchParams({
      client_id: slackOAuthConfig.clientId,
      client_secret: slackOAuthConfig.clientSecret,
      code: input.code,
      redirect_uri: getSlackRedirectUri(),
    });

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP error: ${response.status}` };
    }

    const data: SlackOAuthResponse = await response.json();

    if (!data.ok) {
      console.error(`[exchangeSlackOAuthCode] -> ${JSON.stringify(data)}`);
      return { success: false, error: data.error || 'OAuth exchange failed' };
    }

    if (!data.access_token || !data.team || !data.bot_user_id) {
      return {
        success: false,
        error: 'Missing required data in OAuth response',
      };
    }

    const teamId = data.team.id;
    const botAccessToken = data.access_token;
    const displayMetadata = await resolveSlackBotDisplayMetadata({
      botAccessToken,
      botUserId: data.bot_user_id,
    });

    const installationData = {
      teamName: data.team.name,
      teamDomain: data.team.domain || null,
      enterpriseId: data.enterprise?.id || null,
      enterpriseName: data.enterprise?.name || null,
      appId: data.app_id || slackOAuthConfig.appId,
      botUserId: data.bot_user_id,
      botName: displayMetadata.botName,
      appName: displayMetadata.appName,
      botAccessToken: data.access_token,
      userAccessToken: data.authed_user?.access_token || null,
      scopes: {
        bot: data.scope?.split(',') || [],
        user: data.authed_user?.scope?.split(',') || [],
      },
      tokenType: data.token_type || 'bot',
      installedByUserId: auth.userId,
      isActive: true,
      lastUsedAt: new Date(),
    };

    const savedInstallation = await db
      .insert(slackInstallations)
      .values({ ...installationData, teamId })
      .onConflictDoUpdate({
        target: slackInstallations.teamId,
        set: {
          ...installationData,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!savedInstallation[0]) {
      return {
        success: false,
        error: 'Failed to save installation',
      };
    }

    // Installation should not wait on a best-effort workspace-size snapshot.
    queueMicrotask(() => {
      void refreshSlackInstallationMemberSnapshot({
        botAccessToken,
        teamId,
      }).catch((error) => {
        console.error(
          '[exchangeSlackOAuthCodeCommand] Failed to refresh Slack member snapshot:',
          error,
        );
      });
    });

    if (data.authed_user?.id) {
      await ensureSlackMappingUserExists(auth.userId);
      const { userMapping, status } = await upsertSlackUserMapping({
        slackUserId: data.authed_user.id,
        slackTeamId: data.team.id,
        userId: auth.userId,
      });

      await enqueueSlackAccountLinkEducationIfNeeded({
        status,
        slackTeamId: data.team.id,
        slackUserId: data.authed_user.id,
        userId: auth.userId,
        mappingLinkedAt: userMapping.updatedAt,
        logContext: 'exchangeSlackOAuthCodeCommand',
      });
    }

    return {
      success: true,
      installation: savedInstallation[0],
    };
  } catch (error) {
    console.error('Failed to exchange Slack OAuth code:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function connectSlackAppCommand(
  auth: UserAuthSuccess,
  input: { redirectPath?: string } = {},
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    const adminError = assertAdminResult(auth);
    if (adminError) {
      return adminError;
    }
    const slackOAuthConfig = await resolveSlackOAuthConfig();

    const redirectPath = input.redirectPath ?? '/settings';
    const state = await createSignedSlackInstallState({ redirectPath });
    const url = buildSlackInstallUrl({
      clientId: slackOAuthConfig.clientId,
      state,
      redirectUri: getSlackRedirectUri(),
    });

    return { success: true, url };
  } catch (error) {
    console.error('Failed to generate Slack OAuth URL:', error);

    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to generate OAuth URL',
    };
  }
}

export async function disconnectSlackAppCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const adminError = assertAdminResult(auth);
    if (adminError) {
      return adminError;
    }

    await db.delete(slackInstallations);

    return { success: true };
  } catch (error) {
    console.error('Failed to disconnect Slack app:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to disconnect Slack app',
    };
  }
}

export async function getSlackInstallationCommand(
  _auth: UserAuthSuccess,
): Promise<SlackInstallation | null> {
  return (
    (await db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      orderBy: [desc(slackInstallations.updatedAt)],
    })) ?? null
  );
}

export async function startAuthenticateSlackAccountCommand(
  auth: UserAuthSuccess,
  state?: Record<string, string>,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    const slackOAuthConfig = await resolveSlackOAuthConfig();
    const nonce = crypto.randomUUID();
    const signedState = await createSignedSlackLinkAccountState({
      userId: auth.userId,
      redirectPath: state?.redirect,
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: slackOAuthConfig.clientId,
      scope: 'openid profile',
      redirect_uri: getSlackRedirectUri(),
      state: signedState,
      nonce,
    });

    return {
      success: true,
      url: `https://slack.com/openid/connect/authorize?${params.toString()}`,
    };
  } catch (error) {
    console.error(
      '[startAuthenticateSlackAccountCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function finishAuthenticateSlackAccountCommand(
  auth: UserAuthSuccess,
  input: { code: string; state: string },
): Promise<
  | { success: true; slackUserId: string; teamName: string | null }
  | { success: false; error: string }
> {
  try {
    const decodedState = await decodeSlackOAuthState(input.state);
    if (
      !decodedState ||
      decodedState.mode !== 'link_account' ||
      decodedState.userId !== auth.userId
    ) {
      return {
        success: false,
        error: 'Invalid or expired Slack link state for this session',
      };
    }

    const slackOAuthConfig = await resolveSlackOAuthConfig();
    const tokenParams = new URLSearchParams({
      client_id: slackOAuthConfig.clientId,
      client_secret: slackOAuthConfig.clientSecret,
      code: input.code,
      redirect_uri: getSlackRedirectUri(),
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(
      'https://slack.com/api/openid.connect.token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      },
    );

    if (!tokenResponse.ok) {
      return {
        success: false,
        error: `Token exchange HTTP error: ${tokenResponse.status}`,
      };
    }

    const tokenData: SlackOIDCTokenResponse = await tokenResponse.json();

    if (!tokenData.ok || !tokenData.access_token) {
      console.error(
        '[finishAuthenticateSlackAccountCommand] Token exchange failed:',
        tokenData,
      );
      return {
        success: false,
        error: tokenData.error || 'Token exchange failed',
      };
    }

    const userInfoResponse = await fetch(
      'https://slack.com/api/openid.connect.userInfo',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );

    if (!userInfoResponse.ok) {
      return {
        success: false,
        error: `UserInfo HTTP error: ${userInfoResponse.status}`,
      };
    }

    const userInfo: SlackOIDCUserInfoResponse = await userInfoResponse.json();

    if (!userInfo.ok || !userInfo.sub) {
      console.error(
        '[finishAuthenticateSlackAccountCommand] UserInfo failed:',
        userInfo,
      );
      return {
        success: false,
        error: userInfo.error || 'Failed to retrieve Slack user identity',
      };
    }

    const slackUserId = userInfo.sub;
    const slackTeamId = userInfo['https://slack.com/team_id'];
    const teamName = userInfo['https://slack.com/team_name'] ?? null;

    if (!slackTeamId) {
      return { success: false, error: 'Missing Slack team ID in user info' };
    }

    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.teamId, slackTeamId),
        eq(slackInstallations.isActive, true),
      ),
    });

    if (!installation) {
      return {
        success: false,
        error:
          'Your Slack workspace is not connected to this deployment. Ask an admin to connect it first.',
      };
    }

    const { userMapping, status } = await upsertSlackUserMapping({
      slackUserId,
      slackTeamId,
      userId: auth.userId,
    });

    await enqueueSlackAccountLinkEducationIfNeeded({
      status,
      slackTeamId,
      slackUserId,
      userId: auth.userId,
      mappingLinkedAt: userMapping.updatedAt,
      logContext: 'finishAuthenticateSlackAccountCommand',
    });

    return { success: true, slackUserId, teamName };
  } catch (error) {
    console.error(
      '[finishAuthenticateSlackAccountCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function completePendingSlackAuthenticationCommand(
  auth: UserAuthSuccess,
  input: { stateToken: string },
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const authToken = await db.query.slackAuthTokens.findFirst({
      where: and(
        eq(slackAuthTokens.token, input.stateToken),
        gt(slackAuthTokens.expiresAt, new Date()),
      ),
    });

    if (!authToken) {
      return {
        success: false,
        error: 'Invalid or expired auth token',
      };
    }

    await handleSlackAuthentication({ userId: auth.userId, authToken });
    return { success: true };
  } catch (error) {
    console.error(
      `[completePendingSlackAuthenticationCommand] ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    );

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to complete authentication',
    };
  }
}
