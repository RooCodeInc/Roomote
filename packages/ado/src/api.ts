import { z } from 'zod';

import {
  ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT,
  ALL_REPOSITORIES,
  buildRepositoryCloneUrl,
  stripCloneUrlUserInfo,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type TaskRun,
  authAccounts,
  db,
  environments,
  repositories,
  and,
  eq,
  inArray,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

export * from './ci';

const ADO_PROVIDER = 'ado' satisfies SourceControlProvider;
const DEFAULT_ADO_BASE_URL = 'https://dev.azure.com';
export const ADO_API_VERSION = '7.1';
const ADO_TOKEN_VALIDATION_TIMEOUT_MS = 10_000;
const ADO_ERROR_MESSAGE_MAX_CHARS = 200;
const ADO_ENTRA_TOKEN_SCOPE = 'https://app.vssps.visualstudio.com/.default';
const ADO_ENTRA_RESOURCE_SCOPE =
  '499b84ac-1321-427f-aa17-267ca6975798/.default';
const ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_ADO_GIT_USERNAME = 'ado';
const ADO_SERVICE_HOOK_ENSURE_CONCURRENCY = 5;
const ADO_SERVICE_HOOK_PUBLISHER_ID = 'tfs';
const ADO_SERVICE_HOOK_CONSUMER_ID = 'webHooks';
const ADO_SERVICE_HOOK_CONSUMER_ACTION_ID = 'httpRequest';
const ADO_WEBHOOK_BASIC_AUTH_USERNAME = 'roomote';

const ADO_PULL_REQUEST_SERVICE_HOOK_EVENTS: readonly {
  eventType: string;
  publisherInputs?: Record<string, string>;
  webhookQueryParams?: Record<string, string>;
}[] = [
  { eventType: 'git.pullrequest.created' },
  {
    eventType: 'git.pullrequest.updated',
    publisherInputs: { notificationType: 'PushNotification' },
    webhookQueryParams: { notificationType: 'PushNotification' },
  },
  {
    eventType: 'git.pullrequest.updated',
    publisherInputs: { notificationType: 'StatusUpdateNotification' },
    webhookQueryParams: { notificationType: 'StatusUpdateNotification' },
  },
  { eventType: 'ms.vss-code.git-pullrequest-comment-event' },
] as const;

/** Project-scoped events (no repository publisher input). */
const ADO_PROJECT_SERVICE_HOOK_EVENTS: readonly {
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
}[] = [
  { eventType: 'workitem.commented' },
  // CI Failure Triage: completed builds (result filtered in the handler).
  // resourceVersion 1.0 sends the legacy XAML build shape with no `result`,
  // `sourceBranch`, or `repository`; 2.0 sends the modern Build resource the
  // build.complete handler parses.
  { eventType: 'build.complete', resourceVersion: '2.0' },
] as const;

const adoWorkItemCommentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const adoProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  state: z.string().optional(),
  visibility: z.string().optional(),
});

const adoRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  project: adoProjectSchema,
  defaultBranch: z.string().nullable().optional(),
  remoteUrl: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
  isDisabled: z.boolean().optional(),
});

const adoRepositoryListResponseSchema = z.object({
  count: z.number().optional(),
  value: z.array(adoRepositorySchema),
});
const adoServiceHookSubscriptionSchema = z
  .object({
    id: z.string(),
    publisherId: z.string().optional(),
    eventType: z.string(),
    resourceVersion: z.string().optional(),
    consumerId: z.string().optional(),
    consumerActionId: z.string().optional(),
    publisherInputs: z.record(z.string()).optional(),
    consumerInputs: z.record(z.string()).optional(),
  })
  .passthrough();
const adoServiceHookSubscriptionListResponseSchema = z.object({
  count: z.number().optional(),
  value: z.array(adoServiceHookSubscriptionSchema),
});
const adoCurrentUserSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
    providerDisplayName: z.string().optional(),
  })
  .passthrough();
const adoConnectionDataSchema = z
  .object({
    authenticatedUser: adoCurrentUserSchema,
  })
  .passthrough();
const adoCreatedCommentSchema = z
  .object({ id: z.number().int().optional() })
  .passthrough();
const adoThreadSchema = z
  .object({
    id: z.number().int(),
    comments: z.array(adoCreatedCommentSchema).optional(),
  })
  .passthrough();

export type AdoRepository = z.infer<typeof adoRepositorySchema>;
export type AdoCurrentUser = z.infer<typeof adoCurrentUserSchema>;
type AdoServiceHookSubscription = z.infer<
  typeof adoServiceHookSubscriptionSchema
>;
export type AdoRepositoryCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
  authScheme: 'basic' | 'bearer';
  originBaseUrl: string;
};

export type AdoRepositoryValues = {
  sourceControlProvider: typeof ADO_PROVIDER;
  installationId: null;
  userId: null;
  githubRepoId: null;
  externalRepoId: string;
  host: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  permissions: Record<string, unknown>;
  isActive: true;
  linkedByUserId: string;
};

export type ListAdoRepositoriesOptions = {
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  stopAfter?: number;
};

export type AdoServiceHookEnsureResult = {
  repositoryFullName: string;
  status: 'created' | 'updated' | 'failed';
  error?: string;
};

let cachedAdoDeploymentUser: {
  token: string;
  organizationApiBaseUrl: string;
  user: AdoCurrentUser;
} | null = null;
let cachedAdoEntraToken: { token: string; expiresAt: number } | null = null;
let cachedAdoDelegatedToken: {
  accountId: string;
  token: string;
  expiresAt: number;
} | null = null;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function stripBoundarySlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47 /* / */) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl.trim());

  if (!trimmed) {
    throw new Error('ADO_BASE_URL cannot be empty.');
  }

  return stripTrailingSlashes(new URL(trimmed).toString());
}

function normalizeOrganization(organization: string): string {
  const trimmed = stripBoundarySlashes(organization.trim());

  if (!trimmed) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  return trimmed;
}

type AdoAuthMode = 'pat' | 'entra' | 'delegated';

/**
 * Effective deployment auth mode. `ADO_AUTH_MODE` is only written by the setup
 * and Settings forms, so deployments configured from raw env vars fall back to
 * the same inference {@link resolveAdoToken} uses: a PAT when one is present,
 * otherwise the Entra service principal.
 */
async function resolveAdoAuthMode(): Promise<AdoAuthMode> {
  const authMode = (await resolveDeploymentEnvVar('ADO_AUTH_MODE'))?.trim();

  if (authMode === 'pat' || authMode === 'entra' || authMode === 'delegated') {
    return authMode;
  }

  return (await resolveDeploymentEnvVar('ADO_TOKEN'))?.trim() ? 'pat' : 'entra';
}

async function requestAdoEntraClientCredentialsToken({
  clientId,
  clientSecret,
  tenantId,
  fetchImpl = fetch,
  timeoutMs,
}: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ token: string; expiresIn: number }> {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId.trim())}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        scope: ADO_ENTRA_TOKEN_SCOPE,
        grant_type: 'client_credentials',
      }),
      ...(timeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(timeoutMs) }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Azure DevOps Microsoft Entra token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  const token =
    typeof payload.access_token === 'string' ? payload.access_token : null;

  if (!token) {
    throw new Error(
      'Azure DevOps Microsoft Entra token response did not include an access token.',
    );
  }

  return {
    token,
    expiresIn:
      typeof payload.expires_in === 'number' ? payload.expires_in : 3600,
  };
}

export async function resolveAdoToken(): Promise<string | null> {
  const authMode = await resolveDeploymentEnvVar('ADO_AUTH_MODE');
  if (authMode === 'delegated') {
    return resolveAdoDelegatedToken();
  }

  const pat = await resolveDeploymentEnvVar('ADO_TOKEN');
  if (pat?.trim() && authMode !== 'entra') {
    return pat;
  }

  const clientId = await resolveDeploymentEnvVar('ADO_CLIENT_ID');
  const clientSecret = await resolveDeploymentEnvVar('ADO_CLIENT_SECRET');
  const tenantId =
    (await resolveDeploymentEnvVar('ADO_TENANT_ID')) ??
    (await resolveDeploymentEnvVar('R_MICROSOFT_TENANT_ID'));

  if (!clientId?.trim() || !clientSecret?.trim() || !tenantId?.trim()) {
    return null;
  }

  if (
    cachedAdoEntraToken &&
    cachedAdoEntraToken.expiresAt > Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS
  ) {
    return cachedAdoEntraToken.token;
  }

  const { token, expiresIn } = await requestAdoEntraClientCredentialsToken({
    clientId,
    clientSecret,
    tenantId,
  });

  cachedAdoEntraToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return token;
}

async function resolveAdoDelegatedToken(overrides?: {
  linkedAccountId?: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const linkedAccountId =
    overrides?.linkedAccountId ??
    (await resolveDeploymentEnvVar('ADO_LINKED_ACCOUNT_ID'));
  const clientId =
    overrides?.clientId ?? (await resolveDeploymentEnvVar('ADO_CLIENT_ID'));
  const clientSecret =
    overrides?.clientSecret ??
    (await resolveDeploymentEnvVar('ADO_CLIENT_SECRET'));
  const tenantId =
    overrides?.tenantId ??
    (await resolveDeploymentEnvVar('ADO_TENANT_ID')) ??
    (await resolveDeploymentEnvVar('R_MICROSOFT_TENANT_ID'));

  if (!linkedAccountId?.trim()) {
    return null;
  }

  const account = await db.query.authAccounts.findFirst({
    where: and(
      eq(authAccounts.providerId, 'ado'),
      eq(authAccounts.accountId, linkedAccountId.trim()),
    ),
    columns: {
      id: true,
      accountId: true,
      accessToken: true,
      refreshToken: true,
      accessTokenExpiresAt: true,
    },
  });

  if (!account?.accessToken) {
    return null;
  }

  const expiresAt = account.accessTokenExpiresAt?.getTime() ?? 0;
  if (
    expiresAt > Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS &&
    cachedAdoDelegatedToken?.accountId === account.accountId &&
    cachedAdoDelegatedToken.expiresAt >
      Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS
  ) {
    return cachedAdoDelegatedToken.token;
  }

  if (expiresAt > Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS) {
    cachedAdoDelegatedToken = {
      accountId: account.accountId,
      token: account.accessToken,
      expiresAt,
    };
    return account.accessToken;
  }

  if (
    !account.refreshToken ||
    !clientId?.trim() ||
    !clientSecret?.trim() ||
    !tenantId?.trim()
  ) {
    throw new Error(
      'Azure DevOps delegated connection needs to be reconnected. Open Settings and connect with Microsoft again.',
    );
  }

  const response = await (overrides?.fetchImpl ?? fetch)(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId.trim())}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        refresh_token: account.refreshToken,
        scope: ADO_ENTRA_RESOURCE_SCOPE,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Azure DevOps delegated token refresh failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) {
    throw new Error(
      'Azure DevOps delegated token response did not include an access token.',
    );
  }

  const nextExpiresAt =
    Date.now() +
    (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) * 1000;
  const nextRefreshToken =
    typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : account.refreshToken;

  await db
    .update(authAccounts)
    .set({
      accessToken,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: new Date(nextExpiresAt),
      updatedAt: new Date(),
    })
    .where(eq(authAccounts.id, account.id));

  cachedAdoDelegatedToken = {
    accountId: account.accountId,
    token: accessToken,
    expiresAt: nextExpiresAt,
  };
  return accessToken;
}

export function clearAdoEntraTokenCache(): void {
  cachedAdoEntraToken = null;
  cachedAdoDelegatedToken = null;
}

function isEntraAccessToken(token: string): boolean {
  return token.split('.').length === 3;
}

export function buildAdoAuthorizationHeader(token: string): string {
  if (isEntraAccessToken(token)) {
    return `Bearer ${token}`;
  }

  return buildAdoBasicAuthHeader(token);
}

export async function resolveAdoOrganization(): Promise<string | null> {
  const organization = await resolveDeploymentEnvVar('ADO_ORGANIZATION');
  return organization ? normalizeOrganization(organization) : null;
}

export async function resolveAdoBaseUrl(): Promise<string> {
  const baseUrl = await resolveDeploymentEnvVar('ADO_BASE_URL');
  return normalizeBaseUrl(baseUrl ?? DEFAULT_ADO_BASE_URL);
}

export async function resolveAdoUsername(): Promise<string | null> {
  return resolveDeploymentEnvVar('ADO_USERNAME');
}

export function buildAdoOrganizationApiBaseUrl({
  baseUrl,
  organization,
}: {
  baseUrl: string;
  organization: string;
}): string {
  return stripTrailingSlashes(
    new URL(
      `${encodeURIComponent(normalizeOrganization(organization))}/`,
      `${normalizeBaseUrl(baseUrl)}/`,
    ).toString(),
  );
}

export function buildAdoApiUrl(
  organizationApiBaseUrl: string,
  path: string,
  params: Record<string, string | number | boolean>,
): string {
  const url = new URL(
    path.replace(/^\//, ''),
    `${organizationApiBaseUrl.replace(/\/$/, '')}/`,
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function buildAdoBasicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
}

/**
 * Carries the HTTP status alongside the message so callers can tell a rejected
 * credential apart from any other failure and replace the raw status with
 * actionable text (see {@link describeAdoApiError}).
 */
export class AdoApiError extends Error {
  readonly status: number;
  /** Azure DevOps' own explanation, when the response body carried one. */
  readonly providerMessage: string | null;

  constructor(
    status: number,
    statusText: string,
    providerMessage: string | null = null,
  ) {
    super(`Azure DevOps API request failed: ${status} ${statusText}`);
    this.name = 'AdoApiError';
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

/**
 * Azure DevOps answers a rejected credential with a 203 sign-in page as often
 * as it answers 401/403, so all three mean "this credential cannot do that".
 */
function isAdoAuthorizationFailureStatus(status: number): boolean {
  return status === 203 || status === 401 || status === 403;
}

/**
 * What an admin should actually do about a rejected credential. Entra tokens
 * are minted from the `.default` scope, so an app registration that was never
 * granted the Azure DevOps API permissions — or whose newly added permissions
 * were never saved in the Azure portal, or that was never added to the
 * organization — authenticates fine and fails on every API call instead.
 *
 * Azure DevOps usually names the specific problem in the response body, so
 * that leads when present and one compact remediation sentence follows it.
 * This surfaces as a toast, so the full add-save-consent walkthrough stays in
 * the setup/Settings guidance and the docs rather than being repeated here.
 */
function buildAdoCredentialRejectionMessage({
  authMode,
  status,
  providerMessage,
}: {
  authMode: AdoAuthMode;
  status?: number;
  providerMessage?: string | null;
}): string {
  const suffix = status === undefined ? '' : ` (status ${status})`;
  const detail = providerMessage
    ? ` Azure DevOps said: “${providerMessage}”`
    : '';

  if (authMode === 'pat') {
    return `Azure DevOps rejected the access token${suffix}.${detail} Confirm it is active, belongs to the organization, and has Code read access.`;
  }

  return `Azure DevOps rejected the Microsoft Entra credential${suffix}.${detail} Check that the app registration has the ${ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT} API permissions (saved and admin-consented) and that its service principal was added to the Azure DevOps organization.`;
}

/**
 * Message to surface for a failed Azure DevOps call. Rejected credentials get
 * mode-specific remediation; everything else keeps its original message.
 */
export async function describeAdoApiError(error: unknown): Promise<string> {
  if (
    !(error instanceof AdoApiError) ||
    !isAdoAuthorizationFailureStatus(error.status)
  ) {
    return error instanceof Error ? error.message : String(error);
  }

  return buildAdoCredentialRejectionMessage({
    authMode: await resolveAdoAuthMode(),
    status: error.status,
    providerMessage: error.providerMessage,
  });
}

async function requestAdoJson<T>({
  organizationApiBaseUrl,
  fetchImpl = fetch,
  method = 'GET',
  path,
  params,
  token,
  body,
  schema,
}: {
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'POST' | 'PUT';
  path: string;
  params: Record<string, string | number | boolean>;
  token: string;
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<{ data: T; response: Response }> {
  const response = await fetchImpl(
    buildAdoApiUrl(organizationApiBaseUrl, path, params),
    {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: buildAdoAuthorizationHeader(token),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  if (![200, 201].includes(response.status)) {
    throw new AdoApiError(
      response.status,
      response.statusText,
      readAdoErrorMessage(await response.text().catch(() => '')),
    );
  }

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

export function parseAdoRepositoryFullName(repositoryFullName: string): {
  organization: string;
  project: string;
  repository: string;
} {
  const [organization, project, repository, ...extra] =
    repositoryFullName.split('/');

  if (!organization || !project || !repository || extra.length > 0) {
    throw new Error(
      `Azure DevOps repository names must be in organization/project/repository form: ${repositoryFullName}`,
    );
  }

  return { organization, project, repository };
}

export async function resolveAdoOrganizationApiBaseUrl({
  organization,
  baseUrl,
  organizationApiBaseUrl,
}: {
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
} = {}): Promise<string | null> {
  if (organizationApiBaseUrl?.trim()) {
    return stripTrailingSlashes(organizationApiBaseUrl);
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    return null;
  }

  return buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
}

export async function getAdoDeploymentUser(options?: {
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoCurrentUser | null> {
  const adoToken = options?.token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    return null;
  }

  const organizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl({
    organization: options?.organization,
    baseUrl: options?.baseUrl,
    organizationApiBaseUrl: options?.organizationApiBaseUrl,
  });

  if (!organizationApiBaseUrl) {
    return null;
  }

  if (
    cachedAdoDeploymentUser?.token === adoToken &&
    cachedAdoDeploymentUser.organizationApiBaseUrl === organizationApiBaseUrl
  ) {
    return cachedAdoDeploymentUser.user;
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl: options?.fetchImpl,
    path: '/_apis/connectionData',
    params: { 'api-version': ADO_API_VERSION },
    token: adoToken,
    schema: adoConnectionDataSchema,
  });

  cachedAdoDeploymentUser = {
    token: adoToken,
    organizationApiBaseUrl,
    user: data.authenticatedUser,
  };

  return data.authenticatedUser;
}

export function clearAdoDeploymentUserCache(): void {
  cachedAdoDeploymentUser = null;
}

/**
 * Normalizes an Azure DevOps identity to the key used for linked-account
 * matching. Azure DevOps exposes a user's identity under different ids per
 * surface: the Entra OAuth `connectionData` returns a vssps user id, while
 * pull request comment webhooks deliver an org identity id — the two never
 * match, and neither equals the Entra object id. The `uniqueName` (UPN /
 * email) is the one value present identically on both surfaces, so linked
 * accounts key off it. Lowercasing and trimming keeps the link side and the
 * webhook side in agreement.
 */
export function normalizeAdoLinkedAccountKey(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();

  return normalized ? normalized : null;
}

const adoPullRequestDetailsSchema = z
  .object({ pullRequestId: z.number() })
  .passthrough();

/**
 * Fetches a pull request by repository UUID and pull request number.
 * Returns the raw Azure DevOps pull request resource (repository, refs,
 * identities, ...), used to rehydrate webhook payloads that only carry
 * resource links.
 */
export async function getAdoPullRequest({
  repositoryId,
  pullRequestNumber,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId: string;
  pullRequestNumber: number;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to read Azure DevOps pull requests.',
    );
  }

  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    { organization, baseUrl, organizationApiBaseUrl },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to read Azure DevOps pull requests.',
    );
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    path: `/_apis/git/repositories/${encodeURIComponent(
      repositoryId,
    )}/pullRequests/${pullRequestNumber}`,
    params: { 'api-version': ADO_API_VERSION },
    token: adoToken,
    schema: adoPullRequestDetailsSchema,
  });

  return data;
}

export type AdoTokenValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  | { status: 'unknown'; error: string };

/**
 * Azure DevOps explains most rejections in the response body
 * (`{"message": "TF401444: Please sign-in at least once as …"}`), which is
 * more specific than anything we can infer from the status alone. Pull it out
 * so the admin sees the provider's own diagnosis next to the remediation.
 */
function readAdoErrorMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const message =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { message?: unknown }).message
        : null;

    if (typeof message !== 'string' || !message.trim()) {
      return null;
    }

    const collapsed = message.trim().replace(/\s+/g, ' ');
    return collapsed.length > ADO_ERROR_MESSAGE_MAX_CHARS
      ? `${collapsed.slice(0, ADO_ERROR_MESSAGE_MAX_CHARS)}…`
      : collapsed;
  } catch {
    return null;
  }
}

/**
 * Single real Azure DevOps call every credential must be able to make. This is
 * the same repository listing the sync performs, so a PAT without Code access
 * or an Entra app registration that cannot reach the organization fails at
 * save time with remediation instead of at the first sync with a bare 401.
 *
 * Deliberately not `/_apis/connectionData`: that resource is preview-only and
 * answers 400 unless the api-version carries a `-preview` suffix, which would
 * make a working credential look unverifiable rather than valid.
 */
async function probeAdoCredential({
  token,
  authMode,
  organization,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = ADO_TOKEN_VALIDATION_TIMEOUT_MS,
}: {
  token: string;
  authMode: AdoAuthMode;
  organization: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoTokenValidationResult> {
  try {
    const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
      baseUrl:
        baseUrl === undefined
          ? await resolveAdoBaseUrl()
          : normalizeBaseUrl(baseUrl),
      organization,
    });
    const response = await fetchImpl(
      buildAdoApiUrl(organizationApiBaseUrl, '/_apis/git/repositories', {
        'api-version': ADO_API_VERSION,
        $top: 1,
      }),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: buildAdoAuthorizationHeader(token),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (isAdoAuthorizationFailureStatus(response.status)) {
      return {
        status: 'invalid',
        error: buildAdoCredentialRejectionMessage({
          authMode,
          providerMessage: readAdoErrorMessage(await response.text()),
        }),
      };
    }

    if (response.status !== 200) {
      return {
        status: 'unknown',
        error: `Could not verify the Azure DevOps credential: ${response.status} ${response.statusText}`,
      };
    }

    return { status: 'valid' };
  } catch (error) {
    return {
      status: 'unknown',
      error: `Could not verify the Azure DevOps credential: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function validateAdoToken(params: {
  token: string;
  organization: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoTokenValidationResult> {
  return probeAdoCredential({ ...params, authMode: 'pat' });
}

/**
 * Verifies a Microsoft Entra service principal end to end: the tenant issues a
 * client-credentials token, then that token makes a real Azure DevOps call.
 * The token request only proves the client id/secret/tenant are right — the
 * `.default` scope succeeds no matter which API permissions were consented, so
 * the second step is the one that catches a permission-less app registration.
 */
export async function validateAdoEntraCredentials({
  clientId,
  clientSecret,
  tenantId,
  organization,
  baseUrl,
  fetchImpl,
  timeoutMs = ADO_TOKEN_VALIDATION_TIMEOUT_MS,
}: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  organization: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoTokenValidationResult> {
  let token: string;

  try {
    ({ token } = await requestAdoEntraClientCredentialsToken({
      clientId,
      clientSecret,
      tenantId,
      fetchImpl,
      timeoutMs,
    }));
  } catch (error) {
    return {
      status: 'invalid',
      error: `Microsoft Entra did not issue an Azure DevOps token. Confirm the client ID, client secret, and tenant ID are correct and the client secret has not expired. (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }

  return probeAdoCredential({
    token,
    authMode: 'entra',
    organization,
    baseUrl,
    fetchImpl,
    timeoutMs,
  });
}

/**
 * Verifies the Azure DevOps account linked through delegated sign-in, using
 * the stored access token (refreshed first when it has expired).
 */
export async function validateAdoDelegatedCredentials({
  linkedAccountId,
  clientId,
  clientSecret,
  tenantId,
  organization,
  baseUrl,
  fetchImpl,
  timeoutMs = ADO_TOKEN_VALIDATION_TIMEOUT_MS,
}: {
  linkedAccountId: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  organization: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoTokenValidationResult> {
  let token: string | null;

  try {
    token = await resolveAdoDelegatedToken({
      linkedAccountId,
      clientId,
      clientSecret,
      tenantId,
      fetchImpl,
    });
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!token) {
    return {
      status: 'invalid',
      error:
        'No Azure DevOps account is connected. Connect with Microsoft again, then save.',
    };
  }

  return probeAdoCredential({
    token,
    authMode: 'delegated',
    organization,
    baseUrl,
    fetchImpl,
    timeoutMs,
  });
}

function normalizeAdoParentCommentId(
  parentCommentId: string | number | undefined,
): number {
  const parsedParentCommentId = Number(parentCommentId);

  return Number.isInteger(parsedParentCommentId) && parsedParentCommentId > 0
    ? parsedParentCommentId
    : 1;
}

export async function createAdoPullRequestComment({
  repositoryFullName,
  repositoryId,
  pullRequestNumber,
  threadId,
  parentCommentId,
  body,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryFullName: string;
  repositoryId: string;
  pullRequestNumber: number;
  threadId?: string;
  parentCommentId?: string | number;
  body: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ threadId: string; commentId: string | null }> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to create Azure DevOps pull request comments.',
    );
  }

  const parsedRepository = parseAdoRepositoryFullName(repositoryFullName);
  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    {
      organization: organization ?? parsedRepository.organization,
      baseUrl,
      organizationApiBaseUrl,
    },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to create Azure DevOps pull request comments.',
    );
  }

  const threadsPath = `/${encodeURIComponent(
    parsedRepository.project,
  )}/_apis/git/repositories/${encodeURIComponent(
    repositoryId,
  )}/pullRequests/${pullRequestNumber}/threads`;

  if (threadId?.trim()) {
    const { data } = await requestAdoJson({
      organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: `${threadsPath}/${encodeURIComponent(threadId)}/comments`,
      params: { 'api-version': ADO_API_VERSION },
      token: adoToken,
      body: {
        content: body,
        commentType: 'text',
        parentCommentId: normalizeAdoParentCommentId(parentCommentId),
      },
      schema: adoCreatedCommentSchema,
    });

    return {
      threadId,
      commentId: data.id != null ? String(data.id) : null,
    };
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: threadsPath,
    params: { 'api-version': ADO_API_VERSION },
    token: adoToken,
    body: {
      comments: [{ content: body, commentType: 'text', parentCommentId: 0 }],
      status: 'active',
    },
    schema: adoThreadSchema,
  });

  return {
    threadId: String(data.id),
    commentId:
      data.comments?.[0]?.id != null ? String(data.comments[0].id) : null,
  };
}

export async function createAdoWorkItemComment({
  project,
  workItemId,
  body,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  project: string;
  workItemId: number;
  body: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ commentId: string | null }> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to create Azure DevOps work item comments.',
    );
  }

  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    {
      organization,
      baseUrl,
      organizationApiBaseUrl,
    },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to create Azure DevOps work item comments.',
    );
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: `/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments`,
    params: { 'api-version': '7.1-preview.4' },
    token: adoToken,
    body: { text: body },
    schema: adoWorkItemCommentSchema,
  });

  return {
    commentId: data.id != null ? String(data.id) : null,
  };
}

export async function listAdoRepositories({
  token,
  organization,
  baseUrl,
  fetchImpl,
  stopAfter,
}: ListAdoRepositoriesOptions = {}): Promise<AdoRepository[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error('ADO_TOKEN is required to sync Azure DevOps repositories.');
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    path: '/_apis/git/repositories',
    params: {
      'api-version': ADO_API_VERSION,
      includeHidden: false,
      includeAllUrls: true,
    },
    token: adoToken,
    schema: adoRepositoryListResponseSchema,
  });
  const repositoriesList = data.value.filter(
    (repository) => repository.isDisabled !== true,
  );

  return stopAfter === undefined
    ? repositoriesList
    : repositoriesList.slice(0, stopAfter);
}

function buildAdoWebhookHeaderCredentials(secretToken: string): string {
  return `X-Roomote-Webhook-Secret:${secretToken}`;
}

function buildAdoServiceHookWebhookUrl({
  webhookUrl,
  queryParams,
}: {
  webhookUrl: string;
  queryParams?: Record<string, string>;
}): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return webhookUrl;
  }

  const url = new URL(webhookUrl);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function buildAdoServiceHookSubscriptionBody({
  repositoryId,
  projectId,
  eventType,
  publisherInputs = {},
  resourceVersion,
  webhookUrl,
  secretToken,
}: {
  repositoryId?: string;
  projectId: string;
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
  webhookUrl: string;
  secretToken: string;
}) {
  return {
    publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
    eventType,
    resourceVersion: resourceVersion ?? '1.0',
    consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
    consumerActionId: ADO_SERVICE_HOOK_CONSUMER_ACTION_ID,
    publisherInputs: {
      projectId,
      ...(repositoryId ? { repository: repositoryId } : {}),
      ...publisherInputs,
    },
    consumerInputs: {
      url: webhookUrl,
      basicAuthUsername: ADO_WEBHOOK_BASIC_AUTH_USERNAME,
      basicAuthPassword: secretToken,
      httpHeaders: buildAdoWebhookHeaderCredentials(secretToken),
      resourceDetailsToSend: 'all',
      messagesToSend: 'all',
      detailedMessagesToSend: 'all',
    },
  };
}

async function listAdoServiceHookSubscriptions({
  organizationApiBaseUrl,
  token,
  fetchImpl,
}: {
  organizationApiBaseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookSubscription[]> {
  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    path: '/_apis/hooks/subscriptions',
    params: {
      'api-version': ADO_API_VERSION,
      publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
      consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
      consumerActionId: ADO_SERVICE_HOOK_CONSUMER_ACTION_ID,
    },
    token,
    schema: adoServiceHookSubscriptionListResponseSchema,
  });

  return data.value;
}

function hasMatchingAdoPublisherInputs({
  subscription,
  repositoryId,
  projectId,
  publisherInputs,
}: {
  subscription: AdoServiceHookSubscription;
  repositoryId?: string;
  projectId: string;
  publisherInputs?: Record<string, string>;
}): boolean {
  const existingInputs = subscription.publisherInputs ?? {};

  if (existingInputs.projectId !== projectId) {
    return false;
  }

  if (repositoryId) {
    if (existingInputs.repository !== repositoryId) {
      return false;
    }
  } else if (existingInputs.repository) {
    // Project-scoped hooks must not match repository-scoped subscriptions.
    return false;
  }

  for (const [key, value] of Object.entries(publisherInputs ?? {})) {
    if (existingInputs[key] !== value) {
      return false;
    }
  }

  return true;
}

function findAdoServiceHookSubscription({
  subscriptions,
  eventType,
  repositoryId,
  projectId,
  publisherInputs,
  webhookUrl,
  legacyWebhookUrl,
}: {
  subscriptions: AdoServiceHookSubscription[];
  eventType: string;
  repositoryId?: string;
  projectId: string;
  publisherInputs?: Record<string, string>;
  webhookUrl: string;
  legacyWebhookUrl?: string;
}): AdoServiceHookSubscription | undefined {
  const acceptedWebhookUrls = new Set(
    [webhookUrl, legacyWebhookUrl].filter(Boolean),
  );

  return subscriptions.find(
    (subscription) =>
      subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
      subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
      subscription.consumerActionId === ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
      subscription.eventType === eventType &&
      acceptedWebhookUrls.has(subscription.consumerInputs?.url ?? '') &&
      hasMatchingAdoPublisherInputs({
        subscription,
        repositoryId,
        projectId,
        publisherInputs,
      }),
  );
}

async function upsertAdoServiceHookSubscription({
  repositoryId,
  projectId,
  eventType,
  publisherInputs,
  resourceVersion,
  webhookUrl,
  secretToken,
  subscriptions,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId?: string;
  projectId: string;
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
  webhookUrl: string;
  secretToken: string;
  subscriptions: AdoServiceHookSubscription[];
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const body = buildAdoServiceHookSubscriptionBody({
    repositoryId,
    projectId,
    eventType,
    publisherInputs,
    resourceVersion,
    webhookUrl,
    secretToken,
  });
  const existingSubscription = findAdoServiceHookSubscription({
    subscriptions,
    eventType,
    repositoryId,
    projectId,
    publisherInputs,
    webhookUrl,
    legacyWebhookUrl: webhookUrl,
  });

  if (!existingSubscription) {
    await requestAdoJson({
      organizationApiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: '/_apis/hooks/subscriptions',
      params: { 'api-version': ADO_API_VERSION },
      token,
      body,
      schema: adoServiceHookSubscriptionSchema,
    });
    return 'created';
  }

  await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    method: 'PUT',
    path: `/_apis/hooks/subscriptions/${encodeURIComponent(
      existingSubscription.id,
    )}`,
    params: { 'api-version': ADO_API_VERSION },
    token,
    body,
    schema: adoServiceHookSubscriptionSchema,
  });
  return 'updated';
}

async function ensureAdoRepositoryServiceHooks({
  repositoryId,
  projectId,
  subscriptions,
  webhookUrl,
  secretToken,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId: string;
  projectId: string;
  subscriptions: AdoServiceHookSubscription[];
  webhookUrl: string;
  secretToken: string;
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const statuses: ('created' | 'updated')[] = [];

  for (const descriptor of ADO_PULL_REQUEST_SERVICE_HOOK_EVENTS) {
    const descriptorWebhookUrl = buildAdoServiceHookWebhookUrl({
      webhookUrl,
      queryParams: descriptor.webhookQueryParams,
    });
    statuses.push(
      await upsertAdoServiceHookSubscription({
        repositoryId,
        projectId,
        eventType: descriptor.eventType,
        publisherInputs: descriptor.publisherInputs,
        webhookUrl: descriptorWebhookUrl,
        secretToken,
        subscriptions,
        token,
        organizationApiBaseUrl,
        fetchImpl,
      }),
    );
  }

  return statuses.includes('created') ? 'created' : 'updated';
}

async function ensureAdoProjectServiceHooks({
  projectId,
  subscriptions,
  webhookUrl,
  secretToken,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  projectId: string;
  subscriptions: AdoServiceHookSubscription[];
  webhookUrl: string;
  secretToken: string;
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const statuses: ('created' | 'updated')[] = [];

  for (const descriptor of ADO_PROJECT_SERVICE_HOOK_EVENTS) {
    statuses.push(
      await upsertAdoServiceHookSubscription({
        projectId,
        eventType: descriptor.eventType,
        publisherInputs: descriptor.publisherInputs,
        resourceVersion: descriptor.resourceVersion,
        webhookUrl,
        secretToken,
        subscriptions,
        token,
        organizationApiBaseUrl,
        fetchImpl,
      }),
    );
  }

  return statuses.includes('created') ? 'created' : 'updated';
}

export async function ensureAdoServiceHooksForRepositories({
  repositories,
  webhookUrl,
  secretToken,
  token,
  organization,
  baseUrl,
  fetchImpl,
}: {
  repositories: {
    repositoryFullName: string;
    repositoryId: string;
    projectId: string;
  }[];
  webhookUrl: string;
  secretToken: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookEnsureResult[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to configure Azure DevOps service hooks.',
    );
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to configure Azure DevOps service hooks.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const subscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });
  const results: AdoServiceHookEnsureResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += ADO_SERVICE_HOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + ADO_SERVICE_HOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<AdoServiceHookEnsureResult> =>
            ensureAdoRepositoryServiceHooks({
              repositoryId: repository.repositoryId,
              projectId: repository.projectId,
              subscriptions,
              webhookUrl,
              secretToken,
              token: adoToken,
              organizationApiBaseUrl,
              fetchImpl,
            })
              .then((status) => ({
                repositoryFullName: repository.repositoryFullName,
                status,
              }))
              .catch((error: unknown) => ({
                repositoryFullName: repository.repositoryFullName,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              })),
        ),
      )),
    );
  }

  // Project-scoped hooks (work-item @mentions, build completion) are ensured
  // once per project after the per-repository PR hooks so multi-repo projects
  // only create a single subscription per event. Re-list subscriptions so IDs
  // removed by a preceding unmapped-repo cleanup (or concurrent DELETE) are
  // not PUT-updated as if they still exist.
  const projectSubscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });
  const projectIds = [
    ...new Set(repositories.map((repository) => repository.projectId)),
  ];
  for (const projectId of projectIds) {
    try {
      await ensureAdoProjectServiceHooks({
        projectId,
        subscriptions: projectSubscriptions,
        webhookUrl,
        secretToken,
        token: adoToken,
        organizationApiBaseUrl,
        fetchImpl,
      });
    } catch (error) {
      // Reflect open failures on every repository result from the same project
      // so webhook setup reports something went wrong instead of silent miss.
      const message = error instanceof Error ? error.message : String(error);
      for (const result of results) {
        const repository = repositories.find(
          (entry) => entry.repositoryFullName === result.repositoryFullName,
        );
        if (repository?.projectId === projectId && result.status !== 'failed') {
          result.status = 'failed';
          result.error = message;
        }
      }
    }
  }

  return results;
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).host;
}

function buildAdoRepositoryFullName(
  organization: string,
  repository: AdoRepository,
): string {
  return [
    normalizeOrganization(organization),
    repository.project.name,
    repository.name,
  ].join('/');
}

function normalizeAdoDefaultBranch(branch: string | null | undefined): string {
  return stripAdoGitRef(branch) || 'main';
}

export function stripAdoGitRef(refName: string | null | undefined): string {
  return (refName ?? '').trim().replace(/^refs\/heads\//, '');
}

/**
 * Host of the deployment-configured Azure DevOps base URL (e.g. dev.azure.com).
 * Manual Run matches repository `host` against this so the deployment
 * credential is not pointed at an unrelated collection host.
 */
export async function resolveAdoInstanceHost(): Promise<string> {
  return hostFromBaseUrl(await resolveAdoBaseUrl()).toLowerCase();
}

export type AdoServiceHookRemoveResult = {
  repositoryFullName: string;
  status: 'removed' | 'not_found' | 'failed';
  error?: string;
};

function isRoomoteAdoSubscriptionUrl(
  subscriptionUrl: string | undefined,
  webhookUrl: string,
): boolean {
  if (!subscriptionUrl) {
    return false;
  }

  return (
    subscriptionUrl === webhookUrl ||
    subscriptionUrl.startsWith(`${webhookUrl}?`)
  );
}

/**
 * Removes the Roomote pull-request service-hook subscriptions (matched by
 * the deployment webhook URL, including notificationType query variants)
 * from each repository. Sync uses this to keep service hooks scoped to
 * repositories the deployment actually uses: synced repositories without an
 * environment mapping get their Roomote subscriptions removed instead of
 * refreshed. Failures are collected per repository instead of failing the
 * whole batch.
 *
 * Project-scoped hooks (`workitem.commented`, `build.complete`) are removed
 * only when the project is not in `retainProjectIds` (projects that still have
 * mapped repositories). Deleting them while a mapped repo remains leaves
 * ensure unable to update the deleted subscription id from a stale list.
 */
export async function removeAdoServiceHooksForRepositories({
  repositories,
  webhookUrl,
  retainProjectIds,
  token,
  organization,
  baseUrl,
  fetchImpl = fetch,
}: {
  repositories: {
    repositoryFullName: string;
    repositoryId: string;
    projectId: string;
  }[];
  webhookUrl: string;
  /**
   * Project IDs that still have environment-mapped repositories. Project-
   * scoped hooks (work-item comments, build completion) for these projects
   * are left in place so a partial unmap does not tear down intake.
   */
  retainProjectIds?: Iterable<string>;
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookRemoveResult[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to configure Azure DevOps service hooks.',
    );
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to configure Azure DevOps service hooks.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const subscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });

  const results: AdoServiceHookRemoveResult[] = [];

  const projectEventTypes = new Set(
    ADO_PROJECT_SERVICE_HOOK_EVENTS.map((event) => event.eventType),
  );
  const retainedProjects = new Set(
    [...(retainProjectIds ?? [])].filter((id) => Boolean(id?.trim())),
  );
  // Track project-level hooks deleted once so multi-repo same-project
  // removals don't 404 on a second delete of the same subscription.
  const deletedProjectSubscriptionIds = new Set<string>();

  for (const repository of repositories) {
    const matching = subscriptions.filter(
      (subscription) =>
        subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
        subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
        subscription.consumerActionId === ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
        (subscription.publisherInputs?.repository ?? '') ===
          repository.repositoryId &&
        (subscription.publisherInputs?.projectId ?? '') ===
          repository.projectId &&
        isRoomoteAdoSubscriptionUrl(
          subscription.consumerInputs?.url,
          webhookUrl,
        ),
    );

    // Only tear down project-scoped hooks when no mapped repository remains
    // for this project (caller omits projectId from retainProjectIds).
    const projectMatching = retainedProjects.has(repository.projectId)
      ? []
      : subscriptions.filter(
          (subscription) =>
            subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
            subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
            subscription.consumerActionId ===
              ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
            projectEventTypes.has(subscription.eventType) &&
            !(subscription.publisherInputs?.repository ?? '') &&
            (subscription.publisherInputs?.projectId ?? '') ===
              repository.projectId &&
            isRoomoteAdoSubscriptionUrl(
              subscription.consumerInputs?.url,
              webhookUrl,
            ) &&
            !deletedProjectSubscriptionIds.has(subscription.id),
        );

    if (matching.length === 0 && projectMatching.length === 0) {
      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'not_found',
      });
      continue;
    }

    try {
      for (const subscription of [...matching, ...projectMatching]) {
        const response = await fetchImpl(
          buildAdoApiUrl(
            organizationApiBaseUrl,
            `/_apis/hooks/subscriptions/${encodeURIComponent(subscription.id)}`,
            { 'api-version': ADO_API_VERSION },
          ),
          {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              Authorization: buildAdoBasicAuthHeader(adoToken),
            },
          },
        );

        if (![200, 204, 404].includes(response.status)) {
          throw new Error(
            `Azure DevOps API request failed: ${response.status} ${response.statusText}`,
          );
        }

        if (projectEventTypes.has(subscription.eventType)) {
          deletedProjectSubscriptionIds.add(subscription.id);
        }
      }

      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'removed',
      });
    } catch (error) {
      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export function buildAdoRepositoryValues({
  repository,
  linkedByUserId,
  organization,
  baseUrl = DEFAULT_ADO_BASE_URL,
}: {
  repository: AdoRepository;
  linkedByUserId: string;
  organization: string;
  baseUrl?: string;
}): AdoRepositoryValues {
  const fullName = buildAdoRepositoryFullName(organization, repository);
  const host = hostFromBaseUrl(baseUrl);
  // Azure DevOps remoteUrl embeds the organization as URL userinfo
  // (https://org@dev.azure.com/...), which breaks the worker's git
  // insteadOf proxy rewrite, so store the clone URL without it.
  const cloneUrl = stripCloneUrlUserInfo(
    repository.remoteUrl ??
      buildRepositoryCloneUrl({
        provider: ADO_PROVIDER,
        host,
        repositoryFullName: fullName,
      }),
  );

  return {
    sourceControlProvider: ADO_PROVIDER,
    installationId: null,
    userId: null,
    githubRepoId: null,
    externalRepoId: repository.id,
    host,
    name: repository.name,
    fullName,
    description: repository.project.description ?? null,
    private: repository.project.visibility !== 'public',
    defaultBranch: normalizeAdoDefaultBranch(repository.defaultBranch),
    cloneUrl,
    htmlUrl: repository.webUrl ?? cloneUrl.replace(/\.git$/, ''),
    permissions: {
      projectId: repository.project.id,
      projectState: repository.project.state,
      projectVisibility: repository.project.visibility,
    },
    isActive: true,
    linkedByUserId,
  };
}

export async function syncAdoRepositories({
  userId,
  token,
  organization,
  baseUrl,
  repositories: adoRepositories,
  fetchImpl,
}: {
  userId: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  repositories?: AdoRepository[];
  fetchImpl?: typeof fetch;
}) {
  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  const resolvedBaseUrl =
    baseUrl === undefined
      ? await resolveAdoBaseUrl()
      : normalizeBaseUrl(baseUrl);
  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.sourceControlProvider, ADO_PROVIDER),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repository) => repository.id);

  const repositoriesToSync =
    adoRepositories ??
    (await listAdoRepositories({
      token,
      organization: resolvedOrganization,
      baseUrl: resolvedBaseUrl,
      fetchImpl,
    }));

  const syncedRepositories = [];

  for (const repository of repositoriesToSync) {
    const values = buildAdoRepositoryValues({
      repository,
      linkedByUserId: userId,
      organization: resolvedOrganization,
      baseUrl: resolvedBaseUrl,
    });

    const findExistingRepository = () =>
      db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, ADO_PROVIDER),
          eq(repositories.externalRepoId, values.externalRepoId),
        ),
      });

    const existingRepository = await findExistingRepository();

    if (existingRepository) {
      await db
        .update(repositories)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(repositories.id, existingRepository.id));
    } else {
      await db.insert(repositories).values(values);
    }

    const syncedRepository = await findExistingRepository();

    if (syncedRepository) {
      syncedRepositories.push(syncedRepository);
    }
  }

  const syncedIds = new Set(
    syncedRepositories.map((repository) => repository.id),
  );
  const missingIds = existingIds.filter((id) => !syncedIds.has(id));

  if (missingIds.length > 0) {
    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(repositories.id, missingIds));
  }

  return {
    success: true as const,
    repositories: syncedRepositories,
  };
}

function normalizeRepositorySelection(repositoryNames: string[]): string[] {
  return [...new Set(repositoryNames.filter(Boolean))];
}

async function resolveAdoRepositoryNamesForTaskRun(
  taskRun: TaskRun,
): Promise<string[] | null> {
  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (!environment) {
      throw new Error(
        `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
      );
    }

    return normalizeRepositorySelection(
      environment.config.repositories.map(
        (repository) => repository.repository,
      ),
    );
  }

  if (Array.isArray(taskRun.payload.selectedRepositories)) {
    const selectedRepositories = normalizeRepositorySelection(
      taskRun.payload.selectedRepositories,
    );

    if (selectedRepositories.length > 0) {
      return selectedRepositories;
    }
  }

  if (taskRun.payload.repo && taskRun.payload.repo !== ALL_REPOSITORIES) {
    return [taskRun.payload.repo];
  }

  return null;
}

async function resolveAdoRepositoryRowsForTaskRun(taskRun: TaskRun) {
  const repositoryNames = await resolveAdoRepositoryNamesForTaskRun(taskRun);
  const queryConditions = [
    eq(repositories.sourceControlProvider, ADO_PROVIDER),
    eq(repositories.isActive, true),
  ];

  if (repositoryNames !== null) {
    queryConditions.push(inArray(repositories.fullName, repositoryNames));
  }

  const repositoryRows = await db.query.repositories.findMany({
    where: and(...queryConditions),
    columns: {
      fullName: true,
      cloneUrl: true,
    },
  });

  if (repositoryNames === null) {
    if (repositoryRows.length === 0) {
      throw new Error(
        `No synced Azure DevOps repositories found for task run ${taskRun.id}.`,
      );
    }

    return repositoryRows;
  }

  const repositoryByName = new Map(
    repositoryRows.map((repository) => [repository.fullName, repository]),
  );
  const missingRepositories = repositoryNames.filter(
    (repositoryName) => !repositoryByName.has(repositoryName),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `Selected Azure DevOps repositories not found for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  return repositoryNames.map((repositoryName) => {
    const repository = repositoryByName.get(repositoryName);

    if (!repository?.cloneUrl?.trim()) {
      throw new Error(
        `Azure DevOps repository ${repositoryName} is missing a clone URL.`,
      );
    }

    return repository;
  });
}

function normalizeCredentialRepositoryPath(rawPath: string): string {
  let start = 0;
  while (start < rawPath.length && rawPath.charCodeAt(start) === 47 /* / */) {
    start += 1;
  }

  let path = start === 0 ? rawPath : rawPath.slice(start);
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  return stripTrailingSlashes(path);
}

function stripBasePathPrefix(rawPath: string, originBaseUrl: string): string {
  const basePath = stripTrailingSlashes(new URL(originBaseUrl).pathname);

  if (!basePath || basePath === '/') {
    return rawPath;
  }

  if (rawPath === basePath) {
    return '/';
  }

  if (rawPath.startsWith(`${basePath}/`)) {
    return rawPath.slice(basePath.length);
  }

  return rawPath;
}

function buildAdoGitCredential({
  cloneUrl,
  fallbackRepositoryFullName,
  fallbackHost,
  username,
  token,
  originBaseUrl,
}: {
  cloneUrl: string;
  fallbackRepositoryFullName: string;
  fallbackHost: string;
  username: string;
  token: string;
  originBaseUrl: string;
}): AdoRepositoryCredential {
  try {
    const url = new URL(cloneUrl);
    const repositoryPath = stripBasePathPrefix(url.pathname, originBaseUrl);

    return {
      host: url.host,
      repositoryFullName: normalizeCredentialRepositoryPath(repositoryPath),
      username,
      token,
      authScheme: isEntraAccessToken(token) ? 'bearer' : 'basic',
      originBaseUrl,
    };
  } catch {
    return {
      host: fallbackHost,
      repositoryFullName: fallbackRepositoryFullName,
      username,
      token,
      authScheme: isEntraAccessToken(token) ? 'bearer' : 'basic',
      originBaseUrl,
    };
  }
}

export async function createTaskRunAdoCredentials(
  taskRun: TaskRun,
  options?: {
    token?: string;
    baseUrl?: string;
    username?: string;
  },
): Promise<{
  credentials: AdoRepositoryCredential[];
}> {
  const deploymentToken = options?.token ?? (await resolveAdoToken());

  if (!deploymentToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required for Azure DevOps source control jobs.',
    );
  }

  const baseUrl =
    options?.baseUrl === undefined
      ? await resolveAdoBaseUrl()
      : normalizeBaseUrl(options.baseUrl);
  const username =
    options?.username ??
    (await resolveAdoUsername()) ??
    DEFAULT_ADO_GIT_USERNAME;
  const host = hostFromBaseUrl(baseUrl);
  const repositoriesList = await resolveAdoRepositoryRowsForTaskRun(taskRun);

  return {
    credentials: repositoriesList.map((repository) =>
      buildAdoGitCredential({
        cloneUrl: repository.cloneUrl,
        fallbackRepositoryFullName: repository.fullName,
        fallbackHost: host,
        username,
        token: deploymentToken,
        originBaseUrl: baseUrl,
      }),
    ),
  };
}
