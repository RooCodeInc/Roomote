import { Octokit } from '@octokit/rest';
import type { Endpoints } from '@octokit/types';

import { createAuthToken } from '@roomote/auth';
import * as GitHub from '@roomote/github';
import { createClient } from '@roomote/sdk/client';
import { isLoopbackHostname } from '@roomote/types';
import {
  db,
  githubInstallations,
  githubPendingInstallations,
  githubUserMappings,
  inArray,
  isNotNull,
  isNull,
  repositories,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';
import { encodeRecord } from '@/lib';
import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

type GitHubOAuthUser = Endpoints['GET /user']['response']['data'];

type GitHubOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type CloudActionResult =
  | { success: true; redirectUrl: string }
  | { success: false; error: string };

const GITHUB_APP_DEFAULT_EVENTS = [
  'check_run',
  'check_suite',
  'commit_comment',
  'create',
  'delete',
  'dependabot_alert',
  'deploy_key',
  'deployment',
  'deployment_protection_rule',
  'deployment_review',
  'deployment_status',
  'fork',
  'gollum',
  'installation_target',
  'issue_comment',
  'issue_dependencies',
  'issues',
  'label',
  'merge_group',
  'meta',
  'milestone',
  'public',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'push',
  'release',
  'repository',
  'repository_dispatch',
  'security_advisory',
  'star',
  'status',
  'sub_issues',
  'watch',
  'workflow_dispatch',
  'workflow_job',
  'workflow_run',
] as const;

type GitHubAppManifest = {
  name: string;
  url: string;
  hook_attributes: {
    url: string;
    active: boolean;
  };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  public: boolean;
  default_permissions: {
    actions: 'write';
    checks: 'write';
    contents: 'write';
    deployments: 'read';
    issues: 'write';
    merge_queues: 'read';
    metadata: 'read';
    pull_requests: 'write';
    statuses: 'read';
    vulnerability_alerts: 'read';
    workflows: 'write';
  };
  default_events: (typeof GITHUB_APP_DEFAULT_EVENTS)[number][];
  request_oauth_on_install: boolean;
  setup_on_update: boolean;
};

type GitHubManifestConversionResponse = {
  id?: number;
  slug?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  pem?: string;
};

function getUnauthorizedResult() {
  return {
    success: false as const,
    error: 'Unauthorized',
  };
}

const GITHUB_APP_MANIFEST_TARGET = 'https://github.com/settings/apps/new';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_APP_REQUIRED_CREDENTIAL_GROUPS = [
  ['R_GITHUB_APP_SLUG'],
  ['R_GITHUB_APP_ID'],
  ['R_GITHUB_APP_PRIVATE_KEY'],
  ['R_GITHUB_CLIENT_ID'],
  ['R_GITHUB_CLIENT_SECRET'],
  ['R_GITHUB_WEBHOOK_SECRET'],
] as const;

// GitHub logins are 1-39 characters of alphanumerics and hyphens, without
// leading, trailing, or consecutive hyphens.
const GITHUB_ORGANIZATION_NAME_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

function resolveGitHubAppManifestTarget(
  organization?: string,
): { success: true; target: string } | { success: false; error: string } {
  const normalizedOrganization = organization?.trim() ?? '';

  if (!normalizedOrganization) {
    return { success: true, target: GITHUB_APP_MANIFEST_TARGET };
  }

  if (!GITHUB_ORGANIZATION_NAME_PATTERN.test(normalizedOrganization)) {
    return {
      success: false,
      error:
        'Enter a valid GitHub organization name (letters, numbers, and hyphens only).',
    };
  }

  return {
    success: true,
    target: `https://github.com/organizations/${normalizedOrganization}/settings/apps/new`,
  };
}

async function resolveGitHubAppSlug(): Promise<string | null> {
  const slug = await resolveDeploymentEnvVar('R_GITHUB_APP_SLUG');

  // Do not fall back to the hosted product slug (`roomote`). Unconfigured
  // deployments must create or enter their own app credentials first.
  return slug?.trim() || null;
}

async function isGitHubAppConfigured(): Promise<boolean> {
  for (const aliases of GITHUB_APP_REQUIRED_CREDENTIAL_GROUPS) {
    const values = await Promise.all(
      aliases.map((name) => resolveDeploymentEnvVar(name)),
    );

    if (!values.some((value) => value?.trim())) {
      return false;
    }
  }

  return true;
}

const GITHUB_APP_NOT_CONFIGURED_ERROR =
  'Configure a GitHub App for this deployment before installing. Create one or enter its credentials first.';

function getGitHubCallbackUrl() {
  return new URL('/github/callback', Env.R_APP_URL).toString();
}

function getGitHubWebhookUrl() {
  const trpcUrl = new URL(Env.TRPC_URL);
  const webhookBaseUrl = isLoopbackHostname(trpcUrl.hostname)
    ? Env.R_APP_URL
    : Env.TRPC_URL;

  return new URL('/api/webhooks/github', webhookBaseUrl).toString();
}

function buildGitHubManifestName() {
  // GitHub enforces a 34-character maximum on GitHub App names.
  const GITHUB_APP_NAME_MAX_LENGTH = 34;
  const prefix = 'roomote-';

  const host = new URL(Env.R_APP_URL).hostname
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!host) {
    return 'roomote';
  }

  // Optionally prefix with `roomote-` when the deployment hostname does not
  // already start with `roomote`, then trim the final name to GitHub's limit.
  const candidate = host.startsWith('roomote') ? host : `${prefix}${host}`;

  return candidate.slice(0, GITHUB_APP_NAME_MAX_LENGTH).replace(/-+$/g, '');
}

function buildGitHubAppManifest(): GitHubAppManifest {
  const callbackUrl = getGitHubCallbackUrl();

  return {
    name: buildGitHubManifestName(),
    url: callbackUrl,
    redirect_url: callbackUrl,
    setup_url: callbackUrl,
    callback_urls: [callbackUrl],
    hook_attributes: {
      url: getGitHubWebhookUrl(),
      active: true,
    },
    default_permissions: {
      actions: 'write',
      checks: 'write',
      contents: 'write',
      deployments: 'read',
      issues: 'write',
      merge_queues: 'read',
      metadata: 'read',
      pull_requests: 'write',
      statuses: 'read',
      vulnerability_alerts: 'read',
      workflows: 'write',
    },
    default_events: [...GITHUB_APP_DEFAULT_EVENTS],
    request_oauth_on_install: true,
    setup_on_update: true,
    public: false,
  };
}

function parseManifestConversionResponse(
  data: GitHubManifestConversionResponse,
):
  | {
      success: true;
      values: Array<{ name: string; value: string }>;
    }
  | { success: false; error: string } {
  const id = typeof data.id === 'number' ? String(data.id) : '';
  const privateKey = typeof data.pem === 'string' ? data.pem : '';
  const clientId = typeof data.client_id === 'string' ? data.client_id : '';
  const clientSecret =
    typeof data.client_secret === 'string' ? data.client_secret : '';
  const webhookSecret =
    typeof data.webhook_secret === 'string' ? data.webhook_secret : '';
  const slug = typeof data.slug === 'string' ? data.slug : '';

  if (
    !id ||
    !privateKey ||
    !clientId ||
    !clientSecret ||
    !webhookSecret ||
    !slug
  ) {
    return {
      success: false,
      error: 'GitHub returned an incomplete app manifest conversion response.',
    };
  }

  return {
    success: true,
    values: [
      { name: 'R_GITHUB_APP_ID', value: id },
      { name: 'R_GITHUB_APP_PRIVATE_KEY', value: privateKey },
      { name: 'R_GITHUB_CLIENT_ID', value: clientId },
      { name: 'R_GITHUB_CLIENT_SECRET', value: clientSecret },
      { name: 'R_GITHUB_WEBHOOK_SECRET', value: webhookSecret },
      { name: 'R_GITHUB_APP_SLUG', value: slug },
    ],
  };
}

async function exchangeGitHubAppManifestCode(code: string): Promise<
  | {
      success: true;
      data: GitHubManifestConversionResponse;
    }
  | { success: false; error: string }
> {
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    },
  );

  if (!response.ok) {
    return {
      success: false,
      error: 'Failed to create GitHub App from manifest. Please try again.',
    };
  }

  return {
    success: true,
    data: (await response.json()) as GitHubManifestConversionResponse,
  };
}

async function getGitHubOAuthUser({
  code,
  context,
}: {
  code: string;
  context: string;
}): Promise<
  | {
      success: true;
      githubUser: GitHubOAuthUser;
      githubOAuthToken: Required<
        Pick<GitHubOAuthTokenResponse, 'access_token'>
      > &
        Pick<GitHubOAuthTokenResponse, 'refresh_token' | 'expires_in'>;
    }
  | { success: false; error: string }
> {
  const [clientId, clientSecret] = await Promise.all([
    resolveDeploymentEnvVar('R_GITHUB_CLIENT_ID'),
    resolveDeploymentEnvVar('R_GITHUB_CLIENT_SECRET'),
  ]);

  if (!clientId || !clientSecret) {
    console.error(
      `[${context}] GitHub App OAuth credentials are not configured.`,
    );

    return {
      success: false,
      error:
        'GitHub App OAuth credentials are not configured for this deployment.',
    };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    return { success: false, error: 'Failed to exchange GitHub OAuth code.' };
  }

  const githubOAuthToken: GitHubOAuthTokenResponse = await response.json();

  if (!githubOAuthToken.access_token) {
    return { success: false, error: 'GitHub OAuth code is invalid.' };
  }

  try {
    const githubResponse = await new Octokit({
      auth: githubOAuthToken.access_token,
    }).request('GET /user');

    return {
      success: true,
      githubUser: githubResponse.data,
      githubOAuthToken: {
        access_token: githubOAuthToken.access_token,
        refresh_token: githubOAuthToken.refresh_token,
        expires_in: githubOAuthToken.expires_in,
      },
    };
  } catch (error) {
    console.error(`[${context}] GET /user failed:`, error);
    return { success: false, error: 'Failed to get GitHub user.' };
  }
}

async function upsertGitHubUserMapping({
  userId,
  githubUser,
  githubOAuthToken,
}: {
  userId: string;
  githubUser: Pick<GitHubOAuthUser, 'id' | 'login'>;
  githubOAuthToken: Required<Pick<GitHubOAuthTokenResponse, 'access_token'>> &
    Pick<GitHubOAuthTokenResponse, 'refresh_token' | 'expires_in'>;
}) {
  const tokenExpiresAt =
    typeof githubOAuthToken.expires_in === 'number'
      ? new Date(Date.now() + githubOAuthToken.expires_in * 1000)
      : null;

  await db
    .insert(githubUserMappings)
    .values({
      userId,
      githubLogin: githubUser.login,
      githubUserId: githubUser.id,
      accessToken: githubOAuthToken.access_token,
      refreshToken: githubOAuthToken.refresh_token ?? null,
      tokenExpiresAt,
    })
    .onConflictDoUpdate({
      target: githubUserMappings.githubUserId,
      set: {
        userId,
        githubLogin: githubUser.login,
        accessToken: githubOAuthToken.access_token,
        refreshToken: githubOAuthToken.refresh_token ?? null,
        tokenExpiresAt,
        updatedAt: new Date(),
      },
    });
}

async function revertPrCommit(
  auth: UserAuthSuccess,
  input: {
    repo: string;
    prNumber: number;
    commitSha: string;
  },
): Promise<{
  success: boolean;
  revertSha?: string;
  message?: string;
  error?: string;
}> {
  try {
    const authToken = await createAuthToken({
      userId: auth.userId,
      timeoutMs: 5 * 60 * 1000,
    });

    const client = createClient({
      url: Env.TRPC_URL,
      headers: () => ({ Authorization: `Bearer ${authToken}` }),
    });

    return await client.taskRuns.revertPrCommit.mutate(input);
  } catch (error) {
    console.error('[revertPrCommit]', error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while reverting the commit',
    };
  }
}

export async function startCreateGitHubInstallationCommand(
  auth: UserAuthSuccess,
  state?: Record<string, string>,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  if (!(await isGitHubAppConfigured())) {
    return {
      success: false,
      error: GITHUB_APP_NOT_CONFIGURED_ERROR,
    };
  }

  const appSlug = await resolveGitHubAppSlug();

  if (!appSlug) {
    return {
      success: false,
      error: GITHUB_APP_NOT_CONFIGURED_ERROR,
    };
  }

  const baseUrl = Env.R_APP_URL;
  const params = new URLSearchParams();

  if (state) {
    params.set('state', encodeRecord(state));
  }

  if (baseUrl) {
    const redirectUrl = new URL('/github/callback', baseUrl);
    const callbackBackground = state?.bg;

    if (
      callbackBackground === 'accent' ||
      callbackBackground === 'background'
    ) {
      redirectUrl.searchParams.set('bg', callbackBackground);
    }

    params.set('redirect_url', redirectUrl.toString());
  }

  const query = params.toString();

  return {
    success: true,
    url: `https://github.com/apps/${appSlug}/installations/new${query ? `?${query}` : ''}`,
  };
}

export async function startCreateGitHubAppManifestCommand(
  auth: UserAuthSuccess,
  state?: Record<string, string>,
  organization?: string,
): Promise<
  | {
      success: true;
      postTarget: string;
      values: {
        manifest: string;
      };
    }
  | { success: false; error: string }
> {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  const targetResult = resolveGitHubAppManifestTarget(organization);

  if (!targetResult.success) {
    return targetResult;
  }

  const params = new URLSearchParams();

  if (state) {
    params.set('state', encodeRecord(state));
  }

  return {
    success: true,
    postTarget: `${targetResult.target}${params.size > 0 ? `?${params.toString()}` : ''}`,
    values: {
      manifest: JSON.stringify(buildGitHubAppManifest()),
    },
  };
}

export async function finishCreateGitHubAppManifestCommand(
  auth: UserAuthSuccess,
  input: { code: string; redirect?: string },
): Promise<
  { success: true; installUrl: string } | { success: false; error: string }
> {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  try {
    const exchangeResult = await exchangeGitHubAppManifestCode(input.code);

    if (!exchangeResult.success) {
      return exchangeResult;
    }

    const parsedResult = parseManifestConversionResponse(exchangeResult.data);

    if (!parsedResult.success) {
      return parsedResult;
    }

    await db.transaction(async (tx) => {
      await upsertDeploymentEnvironmentVariables(tx, {
        userId: auth.userId,
        values: parsedResult.values,
      });
    });

    const redirect =
      input.redirect?.trim() || '/setup?step=source-control-connect';

    const installResult = await startCreateGitHubInstallationCommand(auth, {
      mode: 'github-app-install',
      redirect,
    });

    if (!installResult.success) {
      return installResult;
    }

    return {
      success: true,
      installUrl: installResult.url,
    };
  } catch (error) {
    console.error(
      '[finishCreateGitHubAppManifestCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enableGitHubAppCommand(
  auth: UserAuthSuccess,
  state?: Record<string, string>,
): Promise<
  | { success: true; mode: 'synced' }
  | { success: true; mode: 'redirect'; url: string }
  | { success: false; error: string }
> {
  try {
    if (!auth.isAdmin) {
      return getUnauthorizedResult();
    }

    const suspendedInstallations = await db.query.githubInstallations.findMany({
      where: isNotNull(githubInstallations.suspendedAt),
      columns: {
        installationId: true,
      },
    });

    if (suspendedInstallations.length > 0) {
      const results = await Promise.all(
        suspendedInstallations.map(({ installationId }) =>
          GitHub.syncGitHubInstallation({
            userId: auth.userId,
            installationId,
          }),
        ),
      );

      if (results.some((result) => result.success)) {
        return { success: true, mode: 'synced' };
      }
    }

    const installResult = await startCreateGitHubInstallationCommand(
      auth,
      state,
    );
    if (!installResult.success) {
      return installResult;
    }

    return {
      success: true,
      mode: 'redirect',
      url: installResult.url,
    };
  } catch (error) {
    console.error('[enableGitHubAppCommand] Unhandled error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function finishCreateGitHubInstallationCommand(
  auth: UserAuthSuccess,
  input: { code: string },
): Promise<{ success: true } | { success: false; error: string }> {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  try {
    const githubUserResult = await getGitHubOAuthUser({
      code: input.code,
      context: 'finishCreateGitHubInstallationCommand',
    });

    if (!githubUserResult.success) {
      return githubUserResult;
    }

    const { githubUser, githubOAuthToken } = githubUserResult;
    await upsertGitHubUserMapping({
      userId: auth.userId,
      githubUser,
      githubOAuthToken,
    });

    let installationRequest:
      | Endpoints['GET /app/installation-requests']['response']['data'][number]
      | undefined;

    try {
      const appOctokit = await GitHub.getResolvedAppOctokit();
      const response = await appOctokit.request(
        'GET /app/installation-requests',
      );

      installationRequest = response.data.find(
        ({ requester }) => requester.id === githubUser.id,
      );
    } catch (error) {
      console.error(
        '[finishCreateGitHubInstallationCommand] GET /app/installation-requests failed:',
        error,
      );

      return {
        success: false,
        error: 'Failed to get GitHub installation requests.',
      };
    }

    if (!installationRequest) {
      return {
        success: false,
        error: 'No GitHub installation request found.',
      };
    }

    try {
      const [pendingInstallation] = await db
        .insert(githubPendingInstallations)
        .values({
          userId: null,
          requestedByUserId: auth.userId,
          appId: installationRequest.account.id,
          payload: installationRequest,
        })
        .returning();

      if (!pendingInstallation) {
        return {
          success: false,
          error: 'Failed to create GitHub pending installation.',
        };
      }
    } catch (error) {
      console.error(
        '[finishCreateGitHubInstallationCommand] Failed to create GitHub pending installation:',
        error,
      );

      return {
        success: false,
        error: 'Failed to create GitHub pending installation.',
      };
    }

    return { success: true };
  } catch (error) {
    console.error(
      '[finishCreateGitHubInstallationCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startAuthenticateGitHubAccountCommand(
  auth: UserAuthSuccess,
  state?: Record<string, string>,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    const clientId = await resolveDeploymentEnvVar('R_GITHUB_CLIENT_ID');

    if (!clientId) {
      return {
        success: false,
        error:
          'Configure a GitHub App for this deployment before linking your GitHub account. Create one or enter its credentials first.',
      };
    }

    const baseUrl = Env.R_APP_URL;
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'read:user',
      state: encodeRecord({ ...(state ?? {}), mode: 'auth' }),
    });

    if (baseUrl) {
      const redirectUri = new URL('/github/callback', baseUrl);
      const callbackBackground = state?.bg;

      if (
        callbackBackground === 'accent' ||
        callbackBackground === 'background'
      ) {
        redirectUri.searchParams.set('bg', callbackBackground);
      }

      params.set('redirect_uri', redirectUri.toString());
    }

    return {
      success: true,
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
    };
  } catch (error) {
    console.error(
      '[startAuthenticateGitHubAccountCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function finishAuthenticateGitHubAccountCommand(
  auth: UserAuthSuccess,
  input: { code: string },
): Promise<
  { success: true; githubLogin: string } | { success: false; error: string }
> {
  try {
    const githubUserResult = await getGitHubOAuthUser({
      code: input.code,
      context: 'finishAuthenticateGitHubAccountCommand',
    });

    if (!githubUserResult.success) {
      return githubUserResult;
    }

    const { githubUser, githubOAuthToken } = githubUserResult;
    await upsertGitHubUserMapping({
      userId: auth.userId,
      githubUser,
      githubOAuthToken,
    });

    return {
      success: true,
      githubLogin: githubUser.login,
    };
  } catch (error) {
    console.error(
      '[finishAuthenticateGitHubAccountCommand] Unhandled error:',
      error,
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncGitHubInstallationCommand(
  auth: UserAuthSuccess,
  input: { installationId: number },
) {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  return GitHub.syncGitHubInstallation({
    userId: auth.userId,
    installationId: input.installationId,
  });
}

export async function syncGitHubInstallationsCommand(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    return getUnauthorizedResult();
  }

  return GitHub.syncGitHubInstallations({
    userId: auth.userId,
  });
}

export async function disableGitHubAppCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    if (!auth.isAdmin) {
      return getUnauthorizedResult();
    }

    const activeInstallations = await db.query.githubInstallations.findMany({
      where: isNull(githubInstallations.suspendedAt),
      columns: {
        id: true,
      },
    });

    if (activeInstallations.length === 0) {
      return { success: true };
    }

    const installationIds = activeInstallations.map(
      (installation) => installation.id,
    );
    const now = new Date();

    await db
      .update(githubInstallations)
      .set({ suspendedAt: now, updatedAt: now })
      .where(isNull(githubInstallations.suspendedAt));

    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: now })
      .where(inArray(repositories.installationId, installationIds));

    return { success: true };
  } catch (error) {
    console.error('[disableGitHubAppCommand] Unhandled error:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getPullRequestCommand(
  auth: UserAuthSuccess,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
  },
): Promise<
  | { success: true; data: GitHub.PullRequest }
  | { success: false; error: string }
> {
  const result = await GitHub.getPullRequest({
    userId: auth.userId,
    ...input,
  });

  if (!result.success) {
    return result;
  }

  return { success: true, data: result.data };
}

export async function executeRevertCommitCommand(
  auth: UserAuthSuccess,
  input: {
    repo: string;
    prNumber: number;
    commitSha: string;
  },
): Promise<CloudActionResult> {
  const result = await revertPrCommit(auth, input);

  if (result.success) {
    return {
      success: true,
      redirectUrl: `https://github.com/${input.repo}/pull/${input.prNumber}`,
    };
  }

  return {
    success: false,
    error: result.error ?? 'An unknown error occurred.',
  };
}
