import { AsyncLocalStorage } from 'node:async_hooks';

import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth, microsoftEntraId, slack } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { normalizeAdoLinkedAccountKey } from '@roomote/ado';
// Subpath import on purpose: the SDK barrel drags the whole server graph
// into auth, which the auth unit tests mock only partially.
import { sendAgentMailSystemEmail } from '@roomote/sdk/server/agentmail-outbound';
import type { SourceControlTokenBackedProvider } from '@roomote/types';

import {
  authUsers,
  and,
  db,
  eq,
  inArray,
  microsoftAuthUserMappings,
  sourceControlUserMappings,
  teamsUserMappings,
} from '@roomote/db/server';
import * as dbSchema from '@roomote/db/server';

import { Env, getBetterAuthSecret, isEmailChannelEnabled } from './env';
import { getBetterAuthBaseUrlConfig } from './better-auth-base-url';
import { withCanonicalForwardedProto } from './canonical-forwarded-proto';
import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';
import {
  isNewAuthUserEmailAllowed,
  isSignInAllowedByAccessPolicy,
} from './access-policy';
import { hasSeatAvailable } from './license';
import {
  extractInviteTokenFromRequest,
  runWithInviteContext,
} from './invite-context';
import {
  resolveAuthProviderConfig,
  type ResolvedAuthProviderConfig,
} from './auth-provider-config';

type AuthSessionResult = {
  session: {
    id: string;
  };
  user: {
    email: string;
    id: string;
    image?: string | null;
    name?: string | null;
  };
} | null;

type RoomoteAuth = {
  api: {
    getSession(input: { headers: Headers }): Promise<AuthSessionResult>;
    requestPasswordReset(input: {
      body: {
        email: string;
        redirectTo: string;
      };
    }): Promise<unknown>;
    setPassword(input: {
      body: {
        newPassword: string;
      };
      headers: Headers;
    }): Promise<unknown>;
  };
  handler(request: Request): Promise<Response>;
};

type InternalAuth = Awaited<ReturnType<typeof createAuth>>;

let auth: InternalAuth | null = null;
let authSignature: string | null = null;
const resetPasswordLinkCapture = new AsyncLocalStorage<{
  url?: string;
}>();
export const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;

export async function capturePasswordResetLink(
  callback: () => Promise<void>,
): Promise<string | null> {
  const capture: { url?: string } = {};
  await resetPasswordLinkCapture.run(capture, callback);
  return capture.url ?? null;
}
type MicrosoftAuthAccountHookRow = {
  id?: unknown;
  userId?: unknown;
  accountId?: unknown;
  providerId?: unknown;
  idToken?: unknown;
};

type SourceControlAuthAccountHookRow = {
  id?: unknown;
  userId?: unknown;
  accountId?: unknown;
  providerId?: unknown;
  accessToken?: unknown;
};

type SourceControlIdentityProfile = {
  provider: SourceControlTokenBackedProvider;
  host: string;
  externalAccountId: string;
  username: string | null;
  displayName: string | null;
};

type MicrosoftEntraIdTokenClaims = {
  oid?: unknown;
  sub?: unknown;
  tid?: unknown;
};

type GitLabOAuthProfile = {
  avatar_url?: unknown;
  confirmed_at?: unknown;
  email?: unknown;
  id?: unknown;
  name?: unknown;
  public_email?: unknown;
  username?: unknown;
};

type GiteaOAuthProfile = {
  avatar_url?: unknown;
  email?: unknown;
  full_name?: unknown;
  id?: unknown;
  login?: unknown;
};

type BitbucketOAuthProfile = {
  account_id?: unknown;
  display_name?: unknown;
  links?: {
    avatar?: {
      href?: unknown;
    };
  };
  username?: unknown;
  nickname?: unknown;
  uuid?: unknown;
};

type AdoConnectionDataUser = {
  displayName?: unknown;
  id?: unknown;
  providerDisplayName?: unknown;
  uniqueName?: unknown;
};

type AdoConnectionData = {
  authenticatedUser?: AdoConnectionDataUser;
};

type AdoProfile = {
  displayName?: unknown;
  emailAddress?: unknown;
  id?: unknown;
};

const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';
const SLACK_OPENID_SCOPES = ['openid', 'profile', 'email'];
const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.com';
const DEFAULT_ADO_BASE_URL = 'https://dev.azure.com';
const DEFAULT_ADO_ENTRA_TENANT_ID = 'common';
const ADO_API_VERSION = '7.1';
const ADO_CONNECTION_DATA_API_VERSION = '7.1-preview';
const ADO_ENTRA_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const ADO_ENTRA_SCOPES = [`${ADO_ENTRA_RESOURCE_ID}/.default`];

async function isRoomoteAuthSessionAllowed(userId: unknown) {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return false;
  }

  const [authUser] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);

  return isSignInAllowedByAccessPolicy({
    userId,
    email: authUser?.email,
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function syncMicrosoftAuthUserMapping(account: unknown) {
  const row = account as MicrosoftAuthAccountHookRow | null;

  if (!row || row.providerId !== MICROSOFT_ENTRA_PROVIDER_ID) {
    return;
  }

  const authAccountId = readNonEmptyString(row.id);
  const userId = readNonEmptyString(row.userId);
  const accountId = readNonEmptyString(row.accountId);
  const idToken = readNonEmptyString(row.idToken);

  if (!authAccountId || !userId || !accountId || !idToken) {
    return;
  }

  const claims = decodeJwtPayload(
    idToken,
  ) as MicrosoftEntraIdTokenClaims | null;
  const microsoftAadObjectId = readNonEmptyString(claims?.oid);
  const microsoftTenantId = readNonEmptyString(claims?.tid);

  if (!microsoftAadObjectId || !microsoftTenantId) {
    return;
  }

  const now = new Date();

  await db
    .insert(microsoftAuthUserMappings)
    .values({
      authAccountId,
      userId,
      accountId,
      microsoftTenantId,
      microsoftAadObjectId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        microsoftAuthUserMappings.microsoftTenantId,
        microsoftAuthUserMappings.microsoftAadObjectId,
      ],
      set: {
        authAccountId,
        userId,
        accountId,
        updatedAt: now,
      },
    });
}

async function cleanupMicrosoftTeamsUserMappings(account: unknown) {
  const row = account as MicrosoftAuthAccountHookRow | null;

  if (!row || row.providerId !== MICROSOFT_ENTRA_PROVIDER_ID) {
    return;
  }

  const userId = readNonEmptyString(row.userId);
  const accountId = readNonEmptyString(row.accountId);
  const idToken = readNonEmptyString(row.idToken);

  if (!userId || !accountId) {
    return;
  }

  const claims = idToken
    ? (decodeJwtPayload(idToken) as MicrosoftEntraIdTokenClaims | null)
    : null;
  const microsoftAadObjectId =
    readNonEmptyString(claims?.oid) ?? readNonEmptyString(claims?.sub);
  const microsoftTenantId = readNonEmptyString(claims?.tid);
  const aadObjectIds = [
    ...new Set(
      [microsoftAadObjectId, accountId].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ];

  if (aadObjectIds.length === 0) {
    return;
  }

  await db
    .delete(teamsUserMappings)
    .where(
      and(
        eq(teamsUserMappings.userId, userId),
        inArray(teamsUserMappings.teamsAadObjectId, aadObjectIds),
        microsoftTenantId
          ? eq(teamsUserMappings.teamsTenantId, microsoftTenantId)
          : undefined,
      ),
    );
}

function normalizeGitLabBaseUrl(baseUrl: string | null | undefined) {
  const trimmed = baseUrl?.trim();

  return trimmed && trimmed.length > 0
    ? trimmed.replace(/\/+$/, '')
    : DEFAULT_GITLAB_BASE_URL;
}

// Unlike GitLab there is no default Gitea host: Gitea is always
// instance-specific, so the provider stays disabled without GITEA_BASE_URL.
function normalizeBitbucketBaseUrl(baseUrl: string | null | undefined) {
  const trimmed = baseUrl?.trim();

  if (!trimmed) {
    return 'https://bitbucket.org';
  }

  try {
    const url = new URL(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    );
    const host = url.hostname.toLowerCase();

    if (host !== 'bitbucket.org' && host !== 'www.bitbucket.org') {
      return null;
    }

    return 'https://bitbucket.org';
  } catch {
    return null;
  }
}

function normalizeGiteaBaseUrl(baseUrl: string | null | undefined) {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '');

  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeAdoBaseUrl(baseUrl: string | null | undefined) {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '');

  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ADO_BASE_URL;
}

function normalizeAdoOrganization(organization: string | null | undefined) {
  return organization?.trim().replace(/^\/+|\/+$/g, '') ?? null;
}

function buildAdoOrganizationApiBaseUrl({
  baseUrl,
  organization,
}: {
  baseUrl: string;
  organization: string;
}) {
  return new URL(
    `${encodeURIComponent(organization)}/`,
    `${baseUrl.replace(/\/+$/, '')}/`,
  )
    .toString()
    .replace(/\/+$/, '');
}

function buildAdoGlobalApiUrl(path: string, apiVersion: string) {
  const url = new URL(
    path.replace(/^\/+/, ''),
    'https://app.vssps.visualstudio.com/',
  );
  url.searchParams.set('api-version', apiVersion);
  return url.toString();
}

function buildAdoEntraOAuthUrl(
  tenantId: string,
  endpoint: 'authorize' | 'token',
) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/${endpoint}`;
}

function buildGitLabPlaceholderEmail(username: string, baseUrl: string) {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return 'gitlab.local';
    }
  })();

  return `${username}@${host}.placeholder.local`;
}

function buildBitbucketPlaceholderEmail(username: string) {
  return `${username}@users.noreply.bitbucket.org`;
}

function buildGiteaPlaceholderEmail(username: string, baseUrl: string) {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return 'gitea.local';
    }
  })();

  return `${username}@${host}.placeholder.local`;
}

function buildAdoPlaceholderEmail(accountId: string) {
  return `${accountId}@dev.azure.com.placeholder.local`;
}

function readGitLabProfileString(
  profile: GitLabOAuthProfile,
  key: keyof GitLabOAuthProfile,
) {
  return readNonEmptyString(profile[key]);
}

function readGitLabProfileId(profile: GitLabOAuthProfile): string | null {
  if (typeof profile.id === 'number' && Number.isFinite(profile.id)) {
    return String(profile.id);
  }

  return readNonEmptyString(profile.id);
}

function readGiteaProfileString(
  profile: GiteaOAuthProfile,
  key: keyof GiteaOAuthProfile,
) {
  return readNonEmptyString(profile[key]);
}

// The Gitea comment-attribution gate matches auth_accounts.account_id against
// the stringified numeric Gitea user id, so the linked account must store the
// same value.
function readGiteaProfileId(profile: GiteaOAuthProfile): string | null {
  if (typeof profile.id === 'number' && Number.isFinite(profile.id)) {
    return String(profile.id);
  }

  return readNonEmptyString(profile.id);
}

function readBitbucketProfileString(
  profile: BitbucketOAuthProfile,
  key: keyof BitbucketOAuthProfile,
): string | null {
  return readNonEmptyString(profile[key]);
}

function normalizeBitbucketAccountId(value: string): string {
  return value.replace(/^\{|\}$/g, '').trim();
}

function readBitbucketProfileId(profile: BitbucketOAuthProfile): string | null {
  const accountId = readBitbucketProfileString(profile, 'account_id');
  if (accountId) {
    return normalizeBitbucketAccountId(accountId);
  }

  const uuid = readBitbucketProfileString(profile, 'uuid');
  if (uuid) {
    return normalizeBitbucketAccountId(uuid);
  }

  return null;
}

function readAdoProfileString(profile: AdoProfile, key: keyof AdoProfile) {
  return readNonEmptyString(profile[key]);
}

function readAdoConnectionDataUserString(
  user: AdoConnectionDataUser,
  key: keyof AdoConnectionDataUser,
) {
  return readNonEmptyString(user[key]);
}

function getAdoProfileEmail({
  profile,
  user,
  accountId,
}: {
  profile: AdoProfile | null;
  user: AdoConnectionDataUser;
  accountId: string;
}) {
  const emailAddress = profile && readAdoProfileString(profile, 'emailAddress');
  const uniqueName = readAdoConnectionDataUserString(user, 'uniqueName');

  return emailAddress?.includes('@')
    ? emailAddress
    : uniqueName?.includes('@')
      ? uniqueName
      : buildAdoPlaceholderEmail(accountId);
}

function getSourceControlHost(baseUrl: string): string {
  return new URL(baseUrl).host.toLowerCase();
}

async function resolveSourceControlIdentityProfile({
  provider,
  accessToken,
  gitlabBaseUrl,
  giteaBaseUrl,
  bitbucketBaseUrl,
  adoBaseUrl,
}: {
  provider: SourceControlTokenBackedProvider;
  accessToken: string;
  gitlabBaseUrl: string;
  giteaBaseUrl: string | null;
  bitbucketBaseUrl: string;
  adoBaseUrl: string;
}): Promise<SourceControlIdentityProfile | null> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  if (provider === 'gitlab') {
    const response = await fetch(`${gitlabBaseUrl}/api/v4/user`, { headers });
    if (!response.ok) return null;

    const profile = (await response.json()) as GitLabOAuthProfile;
    const externalAccountId = readGitLabProfileId(profile);
    const username = readGitLabProfileString(profile, 'username');
    if (!externalAccountId || !username) return null;

    return {
      provider,
      host: getSourceControlHost(gitlabBaseUrl),
      externalAccountId,
      username,
      displayName: readGitLabProfileString(profile, 'name'),
    };
  }

  if (provider === 'gitea') {
    if (!giteaBaseUrl) return null;
    const response = await fetch(`${giteaBaseUrl}/api/v1/user`, { headers });
    if (!response.ok) return null;

    const profile = (await response.json()) as GiteaOAuthProfile;
    const externalAccountId = readGiteaProfileId(profile);
    const username = readGiteaProfileString(profile, 'login');
    if (!externalAccountId || !username) return null;

    return {
      provider,
      host: getSourceControlHost(giteaBaseUrl),
      externalAccountId,
      username,
      displayName: readGiteaProfileString(profile, 'full_name'),
    };
  }

  if (provider === 'bitbucket') {
    const response = await fetch('https://api.bitbucket.org/2.0/user', {
      headers,
    });
    if (!response.ok) return null;

    const profile = (await response.json()) as BitbucketOAuthProfile;
    const externalAccountId = readBitbucketProfileId(profile);
    if (!externalAccountId) return null;

    return {
      provider,
      host: getSourceControlHost(bitbucketBaseUrl),
      externalAccountId,
      username: readBitbucketProfileString(profile, 'username'),
      displayName:
        readBitbucketProfileString(profile, 'display_name') ??
        readBitbucketProfileString(profile, 'nickname'),
    };
  }

  const [connectionDataResponse, profileResponse] = await Promise.all([
    fetch(
      buildAdoGlobalApiUrl(
        '_apis/connectionData',
        ADO_CONNECTION_DATA_API_VERSION,
      ),
      {
        headers,
      },
    ),
    fetch(buildAdoGlobalApiUrl('_apis/profile/profiles/me', ADO_API_VERSION), {
      headers,
    }).catch(() => null),
  ]);
  if (!connectionDataResponse.ok) return null;

  const connectionData =
    (await connectionDataResponse.json()) as AdoConnectionData;
  const user = connectionData.authenticatedUser;
  const externalAccountId = user && readAdoConnectionDataUserString(user, 'id');
  if (!user || !externalAccountId) return null;

  const profile =
    profileResponse?.ok === true
      ? ((await profileResponse.json()) as AdoProfile)
      : null;

  return {
    provider,
    host: getSourceControlHost(adoBaseUrl),
    externalAccountId,
    // Azure DevOps exposes uniqueName as an email/UPN, not a public handle.
    username: null,
    displayName:
      (profile && readAdoProfileString(profile, 'displayName')) ??
      readAdoConnectionDataUserString(user, 'displayName') ??
      readAdoConnectionDataUserString(user, 'providerDisplayName'),
  };
}

async function syncSourceControlAuthUserMapping(
  account: unknown,
  config: {
    gitlabBaseUrl: string;
    giteaBaseUrl: string | null;
    bitbucketBaseUrl: string;
    adoBaseUrl: string;
  },
) {
  const row = account as SourceControlAuthAccountHookRow | null;
  const provider = readNonEmptyString(row?.providerId);
  if (
    provider !== 'gitlab' &&
    provider !== 'gitea' &&
    provider !== 'bitbucket' &&
    provider !== 'ado'
  ) {
    return;
  }

  const authAccountId = readNonEmptyString(row?.id);
  const userId = readNonEmptyString(row?.userId);
  const accessToken = readNonEmptyString(row?.accessToken);
  if (!authAccountId || !userId || !accessToken) return;

  try {
    const identity = await resolveSourceControlIdentityProfile({
      provider,
      accessToken,
      ...config,
    });
    if (!identity) return;

    const now = new Date();
    await db
      .insert(sourceControlUserMappings)
      .values({
        authAccountId,
        userId,
        sourceControlProvider: identity.provider,
        host: identity.host,
        externalAccountId: identity.externalAccountId,
        username: identity.username,
        displayName: identity.displayName,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sourceControlUserMappings.authAccountId,
        set: {
          userId,
          sourceControlProvider: identity.provider,
          host: identity.host,
          externalAccountId: identity.externalAccountId,
          username: identity.username,
          displayName: identity.displayName,
          updatedAt: now,
        },
      });
  } catch (error) {
    console.error(
      `[auth] Failed to sync ${provider} linked-account identity:`,
      error,
    );
  }
}

async function createAuth(authProviderConfig: ResolvedAuthProviderConfig) {
  const {
    slackClientId,
    slackClientSecret,
    microsoftClientId,
    microsoftClientSecret,
    microsoftTenantId,
    gitlabClientId,
    gitlabClientSecret,
    gitlabBaseUrl,
    giteaClientId,
    giteaClientSecret,
    giteaBaseUrl,
    bitbucketClientId,
    bitbucketClientSecret,
    bitbucketBaseUrl,
    adoClientId,
    adoClientSecret,
    adoTenantId,
    adoOrganization,
    adoBaseUrl,
  } = authProviderConfig;
  const hasMicrosoftAuth =
    microsoftClientId && microsoftClientSecret && microsoftTenantId;
  const normalizedGitLabBaseUrl = normalizeGitLabBaseUrl(gitlabBaseUrl);
  const normalizedGiteaBaseUrl = normalizeGiteaBaseUrl(giteaBaseUrl);
  const normalizedBitbucketBaseUrl =
    normalizeBitbucketBaseUrl(bitbucketBaseUrl);
  const normalizedAdoOrganization = normalizeAdoOrganization(adoOrganization);
  const normalizedAdoBaseUrl = normalizeAdoBaseUrl(adoBaseUrl);
  const normalizedAdoTenantId =
    adoTenantId?.trim() || DEFAULT_ADO_ENTRA_TENANT_ID;
  const adoOrganizationApiBaseUrl = normalizedAdoOrganization
    ? buildAdoOrganizationApiBaseUrl({
        baseUrl: normalizedAdoBaseUrl,
        organization: normalizedAdoOrganization,
      })
    : null;
  const genericOAuthConfigs = [
    ...(slackClientId && slackClientSecret
      ? [
          {
            ...slack({
              clientId: slackClientId,
              clientSecret: slackClientSecret,
              scopes: SLACK_OPENID_SCOPES,
            }),
            authorizationUrlParams: () => ({
              nonce: crypto.randomUUID(),
            }),
          },
        ]
      : []),
    ...(hasMicrosoftAuth
      ? [
          microsoftEntraId({
            clientId: microsoftClientId,
            clientSecret: microsoftClientSecret,
            tenantId: microsoftTenantId,
            // offline_access stores an Entra refresh token so delegated
            // Microsoft Graph tokens (Teams history reads) can be minted for
            // the linked user later.
            scopes: ['openid', 'profile', 'email', 'offline_access'],
          }),
        ]
      : []),
    ...(gitlabClientId && gitlabClientSecret
      ? [
          {
            providerId: 'gitlab',
            authorizationUrl: `${normalizedGitLabBaseUrl}/oauth/authorize`,
            tokenUrl: `${normalizedGitLabBaseUrl}/oauth/token`,
            clientId: gitlabClientId,
            clientSecret: gitlabClientSecret,
            scopes: ['read_user'],
            disableSignUp: true,
            getUserInfo: async (tokens: { accessToken?: string }) => {
              if (!tokens.accessToken) {
                return null;
              }

              const response = await fetch(
                `${normalizedGitLabBaseUrl}/api/v4/user`,
                {
                  headers: {
                    Authorization: `Bearer ${tokens.accessToken}`,
                  },
                },
              );

              if (!response.ok) {
                return null;
              }

              const profile = (await response.json()) as GitLabOAuthProfile;
              const accountId = readGitLabProfileId(profile);
              const username = readGitLabProfileString(profile, 'username');

              if (!accountId || !username) {
                return null;
              }

              const email =
                readGitLabProfileString(profile, 'email') ??
                readGitLabProfileString(profile, 'public_email') ??
                buildGitLabPlaceholderEmail(username, normalizedGitLabBaseUrl);

              return {
                id: accountId,
                email,
                emailVerified: Boolean(
                  readGitLabProfileString(profile, 'confirmed_at'),
                ),
                image:
                  readGitLabProfileString(profile, 'avatar_url') ?? undefined,
                name:
                  readGitLabProfileString(profile, 'name') ?? `@${username}`,
              };
            },
          },
        ]
      : []),
    ...(giteaClientId && giteaClientSecret && normalizedGiteaBaseUrl
      ? [
          {
            providerId: 'gitea',
            authorizationUrl: `${normalizedGiteaBaseUrl}/login/oauth/authorize`,
            tokenUrl: `${normalizedGiteaBaseUrl}/login/oauth/access_token`,
            clientId: giteaClientId,
            clientSecret: giteaClientSecret,
            scopes: ['read:user'],
            disableSignUp: true,
            getUserInfo: async (tokens: { accessToken?: string }) => {
              if (!tokens.accessToken) {
                return null;
              }

              const response = await fetch(
                `${normalizedGiteaBaseUrl}/api/v1/user`,
                {
                  headers: {
                    Authorization: `Bearer ${tokens.accessToken}`,
                  },
                },
              );

              if (!response.ok) {
                return null;
              }

              const profile = (await response.json()) as GiteaOAuthProfile;
              const accountId = readGiteaProfileId(profile);
              const username = readGiteaProfileString(profile, 'login');

              if (!accountId || !username) {
                return null;
              }

              const email =
                readGiteaProfileString(profile, 'email') ??
                buildGiteaPlaceholderEmail(username, normalizedGiteaBaseUrl);

              return {
                id: accountId,
                email,
                emailVerified: false,
                image:
                  readGiteaProfileString(profile, 'avatar_url') ?? undefined,
                name:
                  readGiteaProfileString(profile, 'full_name') ??
                  `@${username}`,
              };
            },
          },
        ]
      : []),
    ...(bitbucketClientId && bitbucketClientSecret && normalizedBitbucketBaseUrl
      ? [
          {
            providerId: 'bitbucket',
            authorizationUrl: 'https://bitbucket.org/site/oauth2/authorize',
            tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
            clientId: bitbucketClientId,
            clientSecret: bitbucketClientSecret,
            scopes: ['account', 'repository', 'pullrequest'],
            disableSignUp: true,
            getUserInfo: async (tokens: { accessToken?: string }) => {
              if (!tokens.accessToken) {
                return null;
              }

              const response = await fetch(
                'https://api.bitbucket.org/2.0/user',
                {
                  headers: {
                    Authorization: `Bearer ${tokens.accessToken}`,
                  },
                },
              );

              if (!response.ok) {
                return null;
              }

              const profile = (await response.json()) as BitbucketOAuthProfile;
              const accountId = readBitbucketProfileId(profile);
              const username = readBitbucketProfileString(profile, 'username');

              if (!accountId) {
                return null;
              }

              const avatarHref =
                typeof profile.links?.avatar?.href === 'string'
                  ? profile.links.avatar.href
                  : undefined;

              return {
                id: accountId,
                email: buildBitbucketPlaceholderEmail(username ?? accountId),
                emailVerified: false,
                image: avatarHref,
                name:
                  readBitbucketProfileString(profile, 'display_name') ??
                  readBitbucketProfileString(profile, 'nickname') ??
                  (username ? `@${username}` : `Bitbucket user ${accountId}`),
              };
            },
          },
        ]
      : []),
    ...(adoClientId && adoClientSecret && adoOrganizationApiBaseUrl
      ? [
          {
            providerId: 'ado',
            authorizationUrl: buildAdoEntraOAuthUrl(
              normalizedAdoTenantId,
              'authorize',
            ),
            tokenUrl: buildAdoEntraOAuthUrl(normalizedAdoTenantId, 'token'),
            clientId: adoClientId,
            clientSecret: adoClientSecret,
            scopes: ADO_ENTRA_SCOPES,
            tokenUrlParams: {
              scope: ADO_ENTRA_SCOPES.join(' '),
            },
            disableSignUp: true,
            getUserInfo: async (tokens: { accessToken?: string }) => {
              if (!tokens.accessToken) {
                return null;
              }

              const authHeaders = {
                Authorization: `Bearer ${tokens.accessToken}`,
              };
              const [connectionDataResponse, profileResponse] =
                await Promise.all([
                  fetch(
                    buildAdoGlobalApiUrl(
                      '_apis/connectionData',
                      ADO_CONNECTION_DATA_API_VERSION,
                    ),
                    { headers: authHeaders },
                  ),
                  fetch(
                    buildAdoGlobalApiUrl(
                      '_apis/profile/profiles/me',
                      ADO_API_VERSION,
                    ),
                    { headers: authHeaders },
                  ).catch(() => null),
                ]);

              if (!connectionDataResponse.ok) {
                return null;
              }

              const connectionData =
                (await connectionDataResponse.json()) as AdoConnectionData;
              const user = connectionData.authenticatedUser;

              if (!user) {
                return null;
              }

              const accountId = readAdoConnectionDataUserString(user, 'id');

              if (!accountId) {
                return null;
              }

              const profile =
                profileResponse?.ok === true
                  ? ((await profileResponse.json()) as AdoProfile)
                  : null;
              const email = getAdoProfileEmail({
                profile,
                user,
                accountId,
              });
              const name =
                (profile && readAdoProfileString(profile, 'displayName')) ??
                readAdoConnectionDataUserString(user, 'displayName') ??
                readAdoConnectionDataUserString(user, 'providerDisplayName') ??
                readAdoConnectionDataUserString(user, 'uniqueName') ??
                `Azure DevOps user ${accountId}`;

              // Key the linked account on the uniqueName (UPN/email). The
              // vssps connectionData `id` used here does not match the org
              // identity id Azure DevOps sends as the comment author on PR
              // webhooks, so id-based matching never resolves. The uniqueName
              // is the one identifier both surfaces share. Fall back to the
              // email and then the vssps id if a uniqueName is unavailable.
              const linkedAccountKey =
                normalizeAdoLinkedAccountKey(
                  readAdoConnectionDataUserString(user, 'uniqueName'),
                ) ??
                normalizeAdoLinkedAccountKey(email) ??
                accountId;

              return {
                id: linkedAccountKey,
                email,
                emailVerified: false,
                name,
              };
            },
          },
        ]
      : []),
  ];

  const emailChannelEnabled = isEmailChannelEnabled();

  return betterAuth({
    appName: 'Roomote',
    baseURL: getBetterAuthBaseUrlConfig({
      previewDomainsRaw: process.env.PREVIEW_DOMAINS,
      roomoteAppUrl: Env.R_APP_URL,
    }),
    secret: getBetterAuthSecret(),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: dbSchema,
    }),
    user: {
      modelName: 'authUsers',
      changeEmail: {
        enabled: true,
      },
    },
    session: {
      modelName: 'authSessions',
      // Better Auth gates account unlinking (and similar operations) behind a
      // "fresh session" check that defaults to one day, which makes
      // Settings > Linked Accounts unlink fail with "Session is not fresh"
      // for any session older than that. Roomote has no re-authentication
      // prompt, so disable the freshness gate and rely on normal session
      // expiry instead.
      freshAge: 0,
    },
    account: {
      modelName: 'authAccounts',
      accountLinking: {
        allowDifferentEmails: true,
      },
    },
    verification: {
      modelName: 'authVerifications',
    },
    // Sign-up is gated by the invite/access checks in the database hooks
    // below. Password sign-in for existing accounts is always available,
    // except that once the email channel is enabled the deployment has an
    // email sender for the first time, so account emails become verifiable
    // and verification is required: Roomote only ever initiates email to an
    // address it has verified, and this is where that guarantee starts.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailChannelEnabled,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // Admin-initiated resets capture the link for the settings UI; with
        // the email channel on, the user also gets it by email.
        const capture = resetPasswordLinkCapture.getStore();
        if (capture) {
          capture.url = url;
        }
        if (emailChannelEnabled) {
          await sendAgentMailSystemEmail({
            to: user.email,
            subject: 'Reset your Roomote password',
            text: [
              'A password reset was requested for your Roomote account.',
              '',
              `[Reset your password](${url})`,
              '',
              `This link expires in ${Math.round(PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS / 60)} minutes. If you did not request a reset, you can ignore this email.`,
            ].join('\n'),
            logContext: 'auth.sendResetPassword',
          });
        }
      },
    },
    ...(emailChannelEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            // An unverified account that signs in gets a fresh verification
            // email instead of a dead-end 403 — this is how accounts created
            // before the channel was enabled get verified.
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) => {
              const result = await sendAgentMailSystemEmail({
                to: user.email,
                subject: 'Verify your email for Roomote',
                text: [
                  'Confirm this address to finish setting up your Roomote account.',
                  '',
                  `[Verify your email](${url})`,
                  '',
                  'If you did not create a Roomote account, you can ignore this email.',
                ].join('\n'),
                logContext: 'auth.sendVerificationEmail',
              });
              if (!result.sent) {
                throw new Error(
                  `Could not send the verification email (${result.reason}).`,
                );
              }
            },
          },
        }
      : {}),
    databaseHooks: {
      account: {
        create: {
          after: async (account) => {
            await Promise.all([
              syncMicrosoftAuthUserMapping(account),
              syncSourceControlAuthUserMapping(account, {
                gitlabBaseUrl: normalizedGitLabBaseUrl,
                giteaBaseUrl: normalizedGiteaBaseUrl,
                bitbucketBaseUrl:
                  normalizedBitbucketBaseUrl ?? 'https://bitbucket.org',
                adoBaseUrl: normalizedAdoBaseUrl,
              }),
            ]);
          },
        },
        update: {
          after: async (account) => {
            await Promise.all([
              syncMicrosoftAuthUserMapping(account),
              syncSourceControlAuthUserMapping(account, {
                gitlabBaseUrl: normalizedGitLabBaseUrl,
                giteaBaseUrl: normalizedGiteaBaseUrl,
                bitbucketBaseUrl:
                  normalizedBitbucketBaseUrl ?? 'https://bitbucket.org',
                adoBaseUrl: normalizedAdoBaseUrl,
              }),
            ]);
          },
        },
        delete: {
          after: async (account) => {
            await cleanupMicrosoftTeamsUserMappings(account);
          },
        },
      },
      user: {
        create: {
          before: async (user, context) => {
            const allowed = await isNewAuthUserEmailAllowed(
              typeof user.email === 'string' ? user.email : null,
              // Email/password sign-up cannot defer to an org-membership
              // check at session creation, so it requires an invite outright.
              { isCredentialSignUp: context?.path === '/sign-up/email' },
            );

            if (!allowed) {
              return false;
            }

            // Seat gate at sign-up time: rejecting here keeps the visitor on
            // the sign-up form with this message and creates no auth user.
            // Advisory only — the authoritative, serialized gate runs in the
            // app-user admission transaction (assertSeatAvailable).
            if (!(await hasSeatAvailable())) {
              throw new APIError('FORBIDDEN', {
                message:
                  'This deployment has reached its licensed user limit. Ask an admin to free a seat or add a license key.',
              });
            }

            return true;
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            return isRoomoteAuthSessionAllowed(session.userId);
          },
        },
      },
    },
    plugins: [
      ...(genericOAuthConfigs.length > 0
        ? [genericOAuth({ config: genericOAuthConfigs })]
        : []),
      nextCookies(),
    ],
  });
}

export async function getAuth(): Promise<RoomoteAuth> {
  await bootstrapWebRuntimeEnv();
  const config = await resolveAuthProviderConfig();

  if (!auth || authSignature !== config.signature) {
    auth = await createAuth(config);
    authSignature = config.signature;
  }

  return auth as RoomoteAuth;
}

export async function handleAuthRequest(request: Request) {
  await bootstrapWebRuntimeEnv();

  const auth = await getAuth();
  const normalizedRequest = withCanonicalForwardedProto(request, Env.R_APP_URL);

  // Expose the visitor's invite cookie to the database hooks above, which
  // otherwise have no access to the request.
  return runWithInviteContext(
    extractInviteTokenFromRequest(normalizedRequest),
    () => auth.handler(normalizedRequest),
  );
}
