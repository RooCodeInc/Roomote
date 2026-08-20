import { buildSlackApiUrl } from '@roomote/slack';
import { db, desc, eq, slackInstallations } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import { buildSlackAppManifest } from '@/lib/slack-app-manifest';

type JsonRecord = Record<string, unknown>;

type SlackManifestError = {
  message?: string;
  pointer?: string;
};

type SlackManifestResponse = {
  ok?: boolean;
  error?: string;
  errors?: SlackManifestError[];
  manifest?: unknown;
  permissions_updated?: boolean;
};

export type UpdateSlackAppManifestResult =
  | {
      success: true;
      changed: boolean;
      reinstallRequired: boolean;
      appSettingsUrl: string;
    }
  | { success: false; error: string };

const CONFIG_TOKEN_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'token_rotated',
]);

const CONFIG_TOKEN_ERROR_MESSAGE =
  'Slack rejected the app configuration token. Generate a fresh token at api.slack.com/apps and try again.';

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(current: unknown, required: readonly string[]) {
  const values = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === 'string')
    : [];

  return [...new Set([...values, ...required])];
}

function mergeRecord(current: unknown, required: JsonRecord): JsonRecord {
  const merged: JsonRecord = isJsonRecord(current) ? { ...current } : {};

  for (const [key, requiredValue] of Object.entries(required)) {
    if (isJsonRecord(requiredValue)) {
      merged[key] = mergeRecord(merged[key], requiredValue);
    } else {
      merged[key] = requiredValue;
    }
  }

  return merged;
}

/**
 * Reconciles Roomote-owned Slack settings while retaining custom fields from
 * the exported manifest. Additive arrays preserve custom scopes, events, and
 * redirect URLs because apps.manifest.update replaces the entire manifest.
 */
export function reconcileSlackAppManifest({
  current,
  required,
}: {
  current: JsonRecord;
  required: ReturnType<typeof buildSlackAppManifest>;
}): JsonRecord {
  const currentOauth = isJsonRecord(current.oauth_config)
    ? current.oauth_config
    : {};
  const currentScopes = isJsonRecord(currentOauth.scopes)
    ? currentOauth.scopes
    : {};
  const currentSettings = isJsonRecord(current.settings)
    ? current.settings
    : {};
  const currentEvents = isJsonRecord(currentSettings.event_subscriptions)
    ? currentSettings.event_subscriptions
    : {};

  const requiredOperationalManifest: JsonRecord = {
    features: {
      app_home: required.features.app_home,
      agent_view: required.features.agent_view,
    },
    oauth_config: {
      redirect_urls: uniqueStrings(
        currentOauth.redirect_urls,
        required.oauth_config.redirect_urls,
      ),
      scopes: {
        ...currentScopes,
        bot: uniqueStrings(currentScopes.bot, required.oauth_config.scopes.bot),
      },
      pkce_enabled: required.oauth_config.pkce_enabled,
    },
    settings: {
      ...required.settings,
      event_subscriptions: {
        ...required.settings.event_subscriptions,
        bot_events: uniqueStrings(
          currentEvents.bot_events,
          required.settings.event_subscriptions.bot_events,
        ),
      },
    },
  };

  return mergeRecord(current, requiredOperationalManifest);
}

function formatSlackError(
  data: SlackManifestResponse | null,
  fallback: string,
) {
  if (data?.error && CONFIG_TOKEN_ERRORS.has(data.error)) {
    return CONFIG_TOKEN_ERROR_MESSAGE;
  }

  const manifestErrors = (data?.errors ?? [])
    .map((error) => {
      const message = error.message?.trim();
      if (!message) return null;
      const pointer = error.pointer?.trim();
      return pointer ? `${message} (${pointer})` : message;
    })
    .filter((message): message is string => message !== null);

  if (manifestErrors.length > 0) {
    return `Slack rejected the updated app manifest: ${manifestErrors.join('; ')}`;
  }

  return data?.error ? `Slack returned an error: ${data.error}` : fallback;
}

async function callManifestApi({
  method,
  configToken,
  body,
}: {
  method:
    | 'apps.manifest.export'
    | 'apps.manifest.validate'
    | 'apps.manifest.update';
  configToken: string;
  body: JsonRecord;
}): Promise<{ response: Response; data: SlackManifestResponse | null }> {
  const response = await fetch(buildSlackApiUrl(method), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${configToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  let data: SlackManifestResponse | null = null;
  try {
    data = (await response.json()) as SlackManifestResponse;
  } catch {
    data = null;
  }

  return { response, data };
}

export async function updateSlackAppManifestCommand(
  auth: UserAuthSuccess,
  input: { configToken: string },
): Promise<UpdateSlackAppManifestResult> {
  if (!auth.isAdmin) {
    return { success: false, error: 'Unauthorized' };
  }

  const configToken = input.configToken.trim();
  if (!configToken) {
    return { success: false, error: 'Enter a Slack app configuration token.' };
  }

  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    orderBy: [desc(slackInstallations.updatedAt)],
  });

  if (!installation) {
    return {
      success: false,
      error: 'Connect a Slack workspace before updating its app manifest.',
    };
  }

  const publicOrigin = getPublicAppUrl(Env).trim();
  if (!publicOrigin) {
    return {
      success: false,
      error:
        'The deployment public URL is not configured, so the Slack app manifest cannot be built.',
    };
  }

  const appSettingsUrl = `https://api.slack.com/apps/${encodeURIComponent(installation.appId)}`;

  try {
    const exported = await callManifestApi({
      method: 'apps.manifest.export',
      configToken,
      body: { app_id: installation.appId },
    });

    if (!exported.data?.ok || !isJsonRecord(exported.data.manifest)) {
      return {
        success: false,
        error: formatSlackError(
          exported.data,
          `Failed to export the Slack app manifest (HTTP ${exported.response.status}).`,
        ),
      };
    }

    const currentManifest = exported.data.manifest;
    const manifest = reconcileSlackAppManifest({
      current: currentManifest,
      required: buildSlackAppManifest({ publicOrigin }),
    });
    const manifestJson = JSON.stringify(manifest);

    if (JSON.stringify(currentManifest) === manifestJson) {
      return {
        success: true,
        changed: false,
        reinstallRequired: false,
        appSettingsUrl,
      };
    }

    const validated = await callManifestApi({
      method: 'apps.manifest.validate',
      configToken,
      body: { app_id: installation.appId, manifest: manifestJson },
    });

    if (!validated.data?.ok) {
      return {
        success: false,
        error: formatSlackError(
          validated.data,
          `Failed to validate the Slack app manifest (HTTP ${validated.response.status}).`,
        ),
      };
    }

    const updated = await callManifestApi({
      method: 'apps.manifest.update',
      configToken,
      body: { app_id: installation.appId, manifest: manifestJson },
    });

    if (!updated.data?.ok) {
      return {
        success: false,
        error: formatSlackError(
          updated.data,
          `Failed to update the Slack app manifest (HTTP ${updated.response.status}).`,
        ),
      };
    }

    return {
      success: true,
      changed: true,
      reinstallRequired: updated.data.permissions_updated === true,
      appSettingsUrl,
    };
  } catch (error) {
    console.error('[updateSlackAppManifestCommand] Failed:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update the Slack app manifest.',
    };
  }
}
