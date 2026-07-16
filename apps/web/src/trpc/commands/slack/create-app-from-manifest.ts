import { buildSlackApiUrl } from '@roomote/slack';
import { db } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';
import { buildSlackAppManifest } from '@/lib/slack-app-manifest';
import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

type SlackManifestCreateError = {
  message?: string;
  pointer?: string;
};

type SlackManifestCreateResponse = {
  ok?: boolean;
  error?: string;
  errors?: SlackManifestCreateError[];
  app_id?: string;
  credentials?: {
    client_id?: string;
    client_secret?: string;
    verification_token?: string;
    signing_secret?: string;
  };
  oauth_authorize_url?: string;
};

type SlackManifestDeleteResponse = {
  ok?: boolean;
  error?: string;
};

type CreateSlackAppFromManifestResult =
  | { success: true; appId: string; appSettingsUrl: string }
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

function formatManifestErrors(
  errors: SlackManifestCreateError[] | undefined,
): string | null {
  const messages = (errors ?? [])
    .map((error) => {
      const message = error.message?.trim();

      if (!message) {
        return null;
      }

      const pointer = error.pointer?.trim();
      return pointer ? `${message} (${pointer})` : message;
    })
    .filter((message): message is string => message !== null);

  if (messages.length === 0) {
    return null;
  }

  return `Slack rejected the generated app manifest: ${messages.join('; ')}`;
}

async function deleteSlackAppFromManifest({
  configToken,
  appId,
}: {
  configToken: string;
  appId: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const response = await fetch(buildSlackApiUrl('apps.manifest.delete'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${configToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId }),
  });

  let data: SlackManifestDeleteResponse | null = null;

  try {
    data = (await response.json()) as SlackManifestDeleteResponse;
  } catch {
    data = null;
  }

  if (data?.ok) {
    return { success: true };
  }

  return {
    success: false,
    error: data?.error
      ? `Slack returned an error while deleting the app: ${data.error}`
      : `Failed to delete the Slack app after credential persistence failed (HTTP ${response.status}).`,
  };
}

/**
 * Creates a Slack app via `apps.manifest.create` using a user-supplied app
 * configuration token, then persists the resulting credentials as deployment
 * environment variables. The configuration token is used for this one call
 * and never stored.
 */
export async function createSlackAppFromManifest({
  configToken,
  actorUserId,
}: {
  configToken: string;
  actorUserId: string | null;
}): Promise<CreateSlackAppFromManifestResult> {
  try {
    const normalizedConfigToken = configToken.trim();

    if (!normalizedConfigToken) {
      return {
        success: false,
        error: 'Enter a Slack app configuration token.',
      };
    }

    const publicOrigin = Env.R_APP_URL?.trim();

    if (!publicOrigin) {
      return {
        success: false,
        error:
          'The deployment public URL is not configured, so the Slack app manifest cannot be built.',
      };
    }

    const manifest = buildSlackAppManifest({ publicOrigin });

    const response = await fetch(buildSlackApiUrl('apps.manifest.create'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${normalizedConfigToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
    });

    let data: SlackManifestCreateResponse | null = null;

    try {
      data = (await response.json()) as SlackManifestCreateResponse;
    } catch {
      data = null;
    }

    if (!data) {
      return {
        success: false,
        error: `Failed to create the Slack app (HTTP ${response.status}). Please try again.`,
      };
    }

    if (!data.ok) {
      if (data.error && CONFIG_TOKEN_ERRORS.has(data.error)) {
        return { success: false, error: CONFIG_TOKEN_ERROR_MESSAGE };
      }

      const manifestError = formatManifestErrors(data.errors);

      if (manifestError) {
        return { success: false, error: manifestError };
      }

      return {
        success: false,
        error: data.error
          ? `Slack returned an error: ${data.error}`
          : 'Slack returned an unknown error while creating the app.',
      };
    }

    const appId = data.app_id?.trim() ?? '';
    const clientId = data.credentials?.client_id?.trim() ?? '';
    const clientSecret = data.credentials?.client_secret?.trim() ?? '';
    const signingSecret = data.credentials?.signing_secret?.trim() ?? '';

    const cleanupCreatedApp = async (reason: string) => {
      const cleanupResult = await deleteSlackAppFromManifest({
        configToken: normalizedConfigToken,
        appId,
      });

      if (!cleanupResult.success) {
        console.error(
          '[createSlackAppFromManifest] Failed to delete created Slack app:',
          cleanupResult.error,
        );

        return {
          success: false,
          error: `${reason} The Slack app ${appId} was created but could not be deleted automatically; delete it from api.slack.com/apps before trying again.`,
        } satisfies CreateSlackAppFromManifestResult;
      }

      return {
        success: false,
        error: `${reason} The Slack app was deleted automatically; try again when the issue is resolved.`,
      } satisfies CreateSlackAppFromManifestResult;
    };

    if (!appId || !clientId || !clientSecret || !signingSecret) {
      if (appId) {
        return await cleanupCreatedApp(
          'Slack returned an incomplete app creation response.',
        );
      }

      return {
        success: false,
        error: 'Slack returned an incomplete app creation response.',
      };
    }

    try {
      await db.transaction(async (tx) => {
        await upsertDeploymentEnvironmentVariables(tx, {
          userId: actorUserId,
          values: [
            { name: 'R_SLACK_CLIENT_ID', value: clientId },
            { name: 'R_SLACK_CLIENT_SECRET', value: clientSecret },
            { name: 'R_SLACK_SIGNING_SECRET', value: signingSecret },
          ],
        });
      });
    } catch (error) {
      console.error(
        '[createSlackAppFromManifest] Failed to persist Slack credentials:',
        error,
      );

      return await cleanupCreatedApp(
        'Slack app credentials could not be saved.',
      );
    }

    return {
      success: true,
      appId,
      appSettingsUrl: `https://api.slack.com/apps/${encodeURIComponent(appId)}`,
    };
  } catch (error) {
    console.error('[createSlackAppFromManifest] Unhandled error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createSlackAppFromManifestCommand(
  auth: UserAuthSuccess,
  input: { configToken: string },
): Promise<CreateSlackAppFromManifestResult> {
  if (!auth.isAdmin) {
    return { success: false, error: 'Unauthorized' };
  }

  return createSlackAppFromManifest({
    configToken: input.configToken,
    actorUserId: auth.userId,
  });
}
