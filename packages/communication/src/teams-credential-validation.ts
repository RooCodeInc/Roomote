import {
  TeamsBotFrameworkClient,
  TeamsOAuthTokenError,
  type FetchLike,
} from './teams-bot-framework-client';

export type TeamsBotCredentialField = 'app_id' | 'app_password' | 'tenant_id';

export type TeamsBotCredentialValidationCode =
  | 'missing_credentials'
  | 'invalid_app_id'
  | 'invalid_app_password'
  | 'expired_app_password'
  | 'invalid_tenant_id'
  | 'rejected'
  | 'unreachable';

export class TeamsBotCredentialValidationError extends Error {
  constructor(
    readonly code: TeamsBotCredentialValidationCode,
    message: string,
    /** Which configured value Microsoft blamed, when it is unambiguous. */
    readonly field: TeamsBotCredentialField | null = null,
    /** Microsoft's own explanation, trimmed to its first line. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'TeamsBotCredentialValidationError';
  }
}

const DEFAULT_VALIDATION_TIMEOUT_MS = 8_000;

/**
 * Entra failures specific enough to name a field for. Anything else falls back
 * to a generic rejection that still carries Microsoft's description.
 */
const AADSTS_FAILURES: Record<
  number,
  { code: TeamsBotCredentialValidationCode; field: TeamsBotCredentialField }
> = {
  // Application with identifier '<app id>' was not found in the directory.
  700016: { code: 'invalid_app_id', field: 'app_id' },
  // Invalid client secret provided (commonly the secret id, not its value).
  7000215: { code: 'invalid_app_password', field: 'app_password' },
  // The provided client secret keys for app '<app id>' are expired.
  7000222: { code: 'expired_app_password', field: 'app_password' },
  // Tenant '<tenant>' not found.
  90002: { code: 'invalid_tenant_id', field: 'tenant_id' },
  // Specified tenant identifier is neither a valid DNS name nor an external domain.
  900023: { code: 'invalid_tenant_id', field: 'tenant_id' },
};

const FIELD_LABELS: Record<TeamsBotCredentialField, string> = {
  app_id: 'app (client) id',
  app_password: 'client secret',
  tenant_id: 'directory (tenant) id',
};

function parseTokenErrorBody(responseBody: string | null): {
  error: string | null;
  description: string | null;
  codes: number[];
} {
  let error: string | null = null;
  let description: string | null = null;
  const codes: number[] = [];

  if (!responseBody) {
    return { error, description, codes };
  }

  try {
    const parsed: unknown = JSON.parse(responseBody);

    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>;

      if (typeof body.error === 'string') {
        error = body.error;
      }

      if (typeof body.error_description === 'string') {
        description = body.error_description;
      }

      if (Array.isArray(body.error_codes)) {
        for (const code of body.error_codes) {
          if (typeof code === 'number' && Number.isFinite(code)) {
            codes.push(code);
          }
        }
      }
    }
  } catch {
    // Proxies and gateways can answer with HTML; the raw body still gets
    // surfaced as the detail below.
  }

  for (const match of (description ?? responseBody).matchAll(/AADSTS(\d+)/gu)) {
    const code = Number.parseInt(match[1] ?? '', 10);

    if (Number.isFinite(code) && !codes.includes(code)) {
      codes.push(code);
    }
  }

  return { error, description, codes };
}

/** Entra descriptions append trace/correlation ids on later lines. */
function firstLine(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.split(/\r?\n/u)[0]?.trim() || null;
}

function classifyTokenError(
  error: TeamsOAuthTokenError,
): TeamsBotCredentialValidationError {
  const parsed = parseTokenErrorBody(error.responseBody);
  const detail =
    firstLine(parsed.description) ??
    firstLine(error.responseBody) ??
    firstLine(error.message);

  for (const code of parsed.codes) {
    const failure = AADSTS_FAILURES[code];

    if (failure) {
      return new TeamsBotCredentialValidationError(
        failure.code,
        `Microsoft rejected the ${FIELD_LABELS[failure.field]}.`,
        failure.field,
        detail,
      );
    }
  }

  if (parsed.error === 'invalid_client') {
    return new TeamsBotCredentialValidationError(
      'invalid_app_password',
      `Microsoft rejected the ${FIELD_LABELS.app_password}.`,
      'app_password',
      detail,
    );
  }

  return new TeamsBotCredentialValidationError(
    'rejected',
    error.status === null
      ? 'Microsoft returned an unusable token response.'
      : `Microsoft rejected the Teams bot credentials (HTTP ${error.status}).`,
    null,
    detail,
  );
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * Proves a Teams bot credential set authenticates by running the same
 * client-credentials flow the bot uses at runtime. Throws a
 * {@link TeamsBotCredentialValidationError} describing which value Microsoft
 * rejected; resolves when the credentials are usable.
 */
export async function validateTeamsBotCredentials(input: {
  appId: string | null | undefined;
  appPassword: string | null | undefined;
  tenantId?: string | null;
  tokenEndpoint?: string | null;
  oauthScope?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const appId = input.appId?.trim();
  const appPassword = input.appPassword?.trim();

  if (!appId || !appPassword) {
    throw new TeamsBotCredentialValidationError(
      'missing_credentials',
      'A Teams bot app id and client secret are required.',
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const fetchImpl = input.fetch ?? fetch;
  const tenantId = input.tenantId?.trim();
  const tokenEndpoint = input.tokenEndpoint?.trim();
  const oauthScope = input.oauthScope?.trim();
  const client = new TeamsBotFrameworkClient({
    appId,
    appPassword,
    ...(tenantId ? { tenantId } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(oauthScope ? { oauthScope } : {}),
    fetch: (url, init) =>
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });

  try {
    await client.verifyCredentials();
  } catch (error) {
    if (error instanceof TeamsOAuthTokenError) {
      throw classifyTokenError(error);
    }

    throw new TeamsBotCredentialValidationError(
      'unreachable',
      isTimeout(error)
        ? 'Could not reach Microsoft to verify the Teams bot credentials (timed out).'
        : 'Could not reach Microsoft to verify the Teams bot credentials.',
      null,
      error instanceof Error ? error.message : String(error),
    );
  }
}
