import {
  and,
  authAccounts,
  db,
  eq,
  resolveDeploymentEnvVar,
  sql,
} from '@roomote/db/server';

export const DEFAULT_ADO_BASE_URL = 'https://dev.azure.com';
export const ADO_API_VERSION = '7.1';
const ADO_TOKEN_VALIDATION_TIMEOUT_MS = 10_000;
const ADO_ERROR_MESSAGE_MAX_CHARS = 240;
const ADO_ENTRA_TOKEN_SCOPE = 'https://app.vssps.visualstudio.com/.default';
const ADO_ENTRA_RESOURCE_SCOPE =
  '499b84ac-1321-427f-aa17-267ca6975798/.default';
const ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS = 60_000;
const ADO_TOKEN_ENDPOINT_TIMEOUT_MS = 15_000;

type AdoAuthMode = 'pat' | 'entra' | 'delegated';

type AdoAccessToken = {
  token: string;
  expiresAt: Date | null;
};

type OAuthErrorResponse = {
  error?: string;
};

let cachedAdoEntraToken: { token: string; expiresAt: number } | null = null;
let cachedAdoDelegatedToken: {
  accountId: string;
  token: string;
  expiresAt: number;
} | null = null;

export type AdoTokenValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  | { status: 'unknown'; error: string };

export function stripTrailingSlashes(value: string): string {
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

export function normalizeAdoBaseUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl.trim());

  if (!trimmed) {
    throw new Error('ADO_BASE_URL cannot be empty.');
  }

  return stripTrailingSlashes(new URL(trimmed).toString());
}

export function normalizeAdoOrganization(organization: string): string {
  const trimmed = stripBoundarySlashes(organization.trim());

  if (!trimmed) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  return trimmed;
}

async function resolveAdoAuthMode(): Promise<AdoAuthMode> {
  const authMode = (await resolveDeploymentEnvVar('ADO_AUTH_MODE'))?.trim();

  if (authMode === 'pat' || authMode === 'entra' || authMode === 'delegated') {
    return authMode;
  }

  return (await resolveDeploymentEnvVar('ADO_TOKEN'))?.trim() ? 'pat' : 'entra';
}

class AdoTokenAcquisitionError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.name = 'AdoTokenAcquisitionError';
    this.definitive = definitive;
  }
}

async function isDefinitiveTokenEndpointFailure(
  response: Response,
): Promise<boolean> {
  if (response.status === 401) {
    return true;
  }
  if (response.status !== 400) {
    return false;
  }

  const error = await response
    .clone()
    .json()
    .then((body) => (body as OAuthErrorResponse).error)
    .catch(() => undefined);
  return ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(
    error ?? '',
  );
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
      signal: AbortSignal.timeout(timeoutMs ?? ADO_TOKEN_ENDPOINT_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new AdoTokenAcquisitionError(
      `Azure DevOps Microsoft Entra token request failed: ${response.status} ${response.statusText}`,
      await isDefinitiveTokenEndpointFailure(response),
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

export async function resolveAdoTokenWithMetadata(): Promise<AdoAccessToken | null> {
  const authMode = await resolveDeploymentEnvVar('ADO_AUTH_MODE');
  if (authMode === 'delegated') {
    return resolveAdoDelegatedToken();
  }

  const pat = await resolveDeploymentEnvVar('ADO_TOKEN');
  if (pat?.trim() && authMode !== 'entra') {
    return { token: pat, expiresAt: null };
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
    return {
      token: cachedAdoEntraToken.token,
      expiresAt: new Date(cachedAdoEntraToken.expiresAt),
    };
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

  return { token, expiresAt: new Date(cachedAdoEntraToken.expiresAt) };
}

export async function resolveAdoToken(): Promise<string | null> {
  return (await resolveAdoTokenWithMetadata())?.token ?? null;
}

async function resolveAdoDelegatedToken(overrides?: {
  linkedAccountId?: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoAccessToken | null> {
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

  if (
    cachedAdoDelegatedToken?.accountId === linkedAccountId.trim() &&
    cachedAdoDelegatedToken.expiresAt >
      Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS
  ) {
    return {
      token: cachedAdoDelegatedToken.token,
      expiresAt: new Date(cachedAdoDelegatedToken.expiresAt),
    };
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ado:${linkedAccountId.trim()}`}, 0))`,
    );
    const account = await tx.query.authAccounts.findFirst({
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

    if (expiresAt > Date.now() + ADO_ENTRA_TOKEN_EXPIRY_SKEW_MS) {
      cachedAdoDelegatedToken = {
        accountId: account.accountId,
        token: account.accessToken,
        expiresAt,
      };
      return { token: account.accessToken, expiresAt: new Date(expiresAt) };
    }

    if (
      !account.refreshToken ||
      !clientId?.trim() ||
      !clientSecret?.trim() ||
      !tenantId?.trim()
    ) {
      throw new AdoTokenAcquisitionError(
        'Azure DevOps delegated connection needs to be reconnected. Open Settings and connect with Microsoft again.',
        true,
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
        signal: AbortSignal.timeout(
          overrides?.timeoutMs ?? ADO_TOKEN_ENDPOINT_TIMEOUT_MS,
        ),
      },
    );

    if (!response.ok) {
      throw new AdoTokenAcquisitionError(
        `Azure DevOps delegated token refresh failed: ${response.status} ${response.statusText}`,
        await isDefinitiveTokenEndpointFailure(response),
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
      (typeof payload.expires_in === 'number' ? payload.expires_in : 3600) *
        1000;
    const nextRefreshToken =
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : account.refreshToken;

    await tx
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
    return { token: accessToken, expiresAt: new Date(nextExpiresAt) };
  });
}

export function clearAdoEntraTokenCache(): void {
  cachedAdoEntraToken = null;
  cachedAdoDelegatedToken = null;
}

export function buildAdoBasicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
}

export function isEntraAccessToken(token: string): boolean {
  return token.split('.').length === 3;
}

export function buildAdoAuthorizationHeader(token: string): string {
  return isEntraAccessToken(token)
    ? `Bearer ${token}`
    : buildAdoBasicAuthHeader(token);
}

export async function resolveAdoOrganization(): Promise<string | null> {
  const organization = await resolveDeploymentEnvVar('ADO_ORGANIZATION');
  return organization ? normalizeAdoOrganization(organization) : null;
}

export async function resolveAdoBaseUrl(): Promise<string> {
  const baseUrl = await resolveDeploymentEnvVar('ADO_BASE_URL');
  return normalizeAdoBaseUrl(baseUrl ?? DEFAULT_ADO_BASE_URL);
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
      `${encodeURIComponent(normalizeAdoOrganization(organization))}/`,
      `${normalizeAdoBaseUrl(baseUrl)}/`,
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

export class AdoApiError extends Error {
  readonly status: number;
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

function isAdoAuthorizationFailureStatus(status: number): boolean {
  return status === 203 || status === 401 || status === 403;
}

const GUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function compactAdoProviderMessage(message: string): string {
  return message
    .replace(GUID_PATTERN, '…')
    .replace(/…(\\+…)+/g, '…')
    .replace(/\s{2,}/g, ' ');
}

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
  const quote = providerMessage
    ? `: “${compactAdoProviderMessage(providerMessage)}”`
    : '.';

  if (authMode === 'pat') {
    return `Azure DevOps rejected the access token${suffix}${quote} Confirm it is active, belongs to the organization, and has Code read access.`;
  }

  return `Azure DevOps rejected the Microsoft Entra credential${suffix}${quote} Check API permissions and organization membership.`;
}

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

export function readAdoErrorMessage(body: string): string | null {
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
          : normalizeAdoBaseUrl(baseUrl),
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
    if (error instanceof AdoTokenAcquisitionError && error.definitive) {
      return {
        status: 'invalid',
        error: `Microsoft Entra did not issue an Azure DevOps token. Confirm the client ID, client secret, and tenant ID are correct and the client secret has not expired. (${error.message})`,
      };
    }

    return {
      status: 'unknown',
      error: `Could not verify the Microsoft Entra credential: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
    token =
      (
        await resolveAdoDelegatedToken({
          linkedAccountId,
          clientId,
          clientSecret,
          tenantId,
          fetchImpl,
          timeoutMs,
        })
      )?.token ?? null;
  } catch (error) {
    if (error instanceof AdoTokenAcquisitionError && error.definitive) {
      return { status: 'invalid', error: error.message };
    }

    return {
      status: 'unknown',
      error: `Could not verify the delegated Azure DevOps connection: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
