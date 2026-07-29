import { createHash } from 'node:crypto';

import {
  TeamsBotCredentialValidationError,
  validateTeamsBotCredentials,
  type TeamsBotCredentialField,
  type TeamsBotCredentialValidationCode,
} from '@roomote/communication/teams-credential-validation';
import {
  getSetupAuthProvider,
  resolveTeamsBotRuntimeCredentialsFromEnv,
  TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES,
  type TeamsBotCredentialSource,
  type TeamsBotRuntimeCredentials,
} from '@roomote/types';

import { getPersistedEnvironmentVariableValues } from '../environment-variables';

/**
 * Saves block on this check, so keep it short enough that a wedged network
 * does not look like a hung form.
 */
const SAVE_VALIDATION_TIMEOUT_MS = 8_000;
const STATUS_VALIDATION_TIMEOUT_MS = 5_000;
const STATUS_CHECK_CACHE_TTL_MS = 60_000;

const FIELD_ENV_VAR_NAMES: Record<
  TeamsBotCredentialField,
  Record<Exclude<TeamsBotCredentialSource, null>, string>
> = {
  app_id: {
    teams_bot: 'R_TEAMS_BOT_APP_ID',
    microsoft_auth: 'R_MICROSOFT_CLIENT_ID',
  },
  app_password: {
    teams_bot: 'R_TEAMS_BOT_APP_PASSWORD',
    microsoft_auth: 'R_MICROSOFT_CLIENT_SECRET',
  },
  tenant_id: {
    teams_bot: 'R_TEAMS_BOT_TENANT_ID',
    microsoft_auth: 'R_MICROSOFT_TENANT_ID',
  },
};

const FIELD_GUIDANCE: Partial<
  Record<TeamsBotCredentialValidationCode, string>
> = {
  invalid_app_id:
    'Copy the Application (client) ID from the Entra app registration overview.',
  invalid_app_password:
    'Use the client secret Value from Certificates & secrets, not the Secret ID.',
  expired_app_password:
    'Create a new client secret in Certificates & secrets and save its value here.',
  invalid_tenant_id:
    'Copy the Directory (tenant) ID from the Entra app registration overview.',
};

function getFieldDescription(
  field: TeamsBotCredentialField,
  source: TeamsBotCredentialSource,
): string {
  const envVarName = source ? FIELD_ENV_VAR_NAMES[field][source] : null;

  if (!envVarName) {
    return 'the Teams bot credentials';
  }

  const label = getSetupAuthProvider('microsoft').fields.find(
    (candidate) => candidate.envVarName === envVarName,
  )?.label;

  return label ? `${label} (${envVarName})` : envVarName;
}

/**
 * Turn a validation failure into copy an admin can act on: which value
 * Microsoft rejected, what Microsoft said, and where to find the right value.
 */
function describeTeamsBotCredentialFailure(
  error: TeamsBotCredentialValidationError,
  source: TeamsBotCredentialSource,
): string {
  const detail = error.detail ? ` ${error.detail}` : '';

  if (error.code === 'unreachable') {
    return `${error.message}${detail} Check outbound access to login.microsoftonline.com and try again.`;
  }

  if (!error.field) {
    return `${error.message}${detail}`;
  }

  const guidance = FIELD_GUIDANCE[error.code];

  return `Microsoft rejected ${getFieldDescription(error.field, source)}.${detail}${
    guidance ? ` ${guidance}` : ''
  }`;
}

/**
 * Resolve the Teams bot credentials a save is about to produce, the same way
 * `resolveTeamsBotRuntimeCredentials` resolves them at runtime: real
 * environment variables win, then the values being submitted, then what is
 * already stored.
 */
async function resolvePendingTeamsBotCredentials(
  values: Partial<Record<string, string>> | undefined,
): Promise<TeamsBotRuntimeCredentials> {
  const persisted = await getPersistedEnvironmentVariableValues([
    ...TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES,
  ]);
  const merged: Partial<Record<string, string>> = {};

  for (const name of TEAMS_BOT_CREDENTIAL_ENV_VAR_NAMES) {
    merged[name] =
      process.env[name]?.trim() || values?.[name]?.trim() || persisted[name];
  }

  return resolveTeamsBotRuntimeCredentialsFromEnv(merged);
}

/**
 * Fail a Microsoft/Teams save when the credentials have never authenticated.
 * Presence of non-empty values used to be enough to report "Bot configured",
 * which left admins unable to tell a typo from a missing permission until the
 * Azure Bot Service started getting 401s from the messaging endpoint.
 */
export async function assertTeamsBotCredentialsAuthenticate(
  values: Partial<Record<string, string>> | undefined,
): Promise<void> {
  const credentials = await resolvePendingTeamsBotCredentials(values);

  if (!credentials.botAppId || !credentials.botAppPassword) {
    // The per-field required-value check reports missing values with copy that
    // points at the specific empty field.
    return;
  }

  try {
    await validateTeamsBotCredentials({
      appId: credentials.botAppId,
      appPassword: credentials.botAppPassword,
      tenantId: credentials.botTenantId,
      tokenEndpoint: credentials.botTokenEndpoint,
      oauthScope: credentials.botOauthScope,
      timeoutMs: SAVE_VALIDATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof TeamsBotCredentialValidationError) {
      throw new Error(
        describeTeamsBotCredentialFailure(error, credentials.source),
      );
    }

    throw error;
  }
}

export type TeamsBotCredentialCheck = {
  /**
   * `unchecked` means Roomote could not get an answer from Microsoft (no
   * credentials configured, or the token endpoint was unreachable) — it is not
   * a verdict on the credentials.
   */
  status: 'ok' | 'failed' | 'unchecked';
  message: string | null;
};

let cachedStatusCheck: {
  key: string;
  value: TeamsBotCredentialCheck;
  expiresAtMs: number;
} | null = null;

function getCredentialCacheKey(
  credentials: TeamsBotRuntimeCredentials,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        credentials.botAppId,
        credentials.botAppPassword,
        credentials.botTenantId,
        credentials.botTokenEndpoint,
        credentials.botOauthScope,
      ]),
    )
    .digest('hex');
}

/**
 * Report whether the currently resolved Teams bot credentials authenticate.
 * Credentials supplied through real environment variables never pass through a
 * save, and client secrets expire, so status cannot infer this from presence.
 * Cached briefly because the settings page polls it.
 */
export async function checkTeamsBotCredentials(
  credentials: TeamsBotRuntimeCredentials,
): Promise<TeamsBotCredentialCheck> {
  if (!credentials.botAppId || !credentials.botAppPassword) {
    return { status: 'unchecked', message: null };
  }

  const key = getCredentialCacheKey(credentials);
  const nowMs = Date.now();

  if (cachedStatusCheck?.key === key && cachedStatusCheck.expiresAtMs > nowMs) {
    return cachedStatusCheck.value;
  }

  let value: TeamsBotCredentialCheck;

  try {
    await validateTeamsBotCredentials({
      appId: credentials.botAppId,
      appPassword: credentials.botAppPassword,
      tenantId: credentials.botTenantId,
      tokenEndpoint: credentials.botTokenEndpoint,
      oauthScope: credentials.botOauthScope,
      timeoutMs: STATUS_VALIDATION_TIMEOUT_MS,
    });
    value = { status: 'ok', message: null };
  } catch (error) {
    if (error instanceof TeamsBotCredentialValidationError) {
      const message = describeTeamsBotCredentialFailure(
        error,
        credentials.source,
      );
      value =
        error.code === 'unreachable'
          ? { status: 'unchecked', message }
          : { status: 'failed', message };
    } else {
      value = {
        status: 'unchecked',
        message: 'Could not verify the Teams bot credentials with Microsoft.',
      };
    }
  }

  cachedStatusCheck = {
    key,
    value,
    expiresAtMs: nowMs + STATUS_CHECK_CACHE_TTL_MS,
  };

  return value;
}

/** Drop the cached status verdict, e.g. right after credentials change. */
export function invalidateTeamsBotCredentialCheckCache(): void {
  cachedStatusCheck = null;
}
