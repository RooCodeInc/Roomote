import {
  db,
  deploymentSettings,
  eq,
  invalidateTeamsBotRuntimeCredentialsCache,
} from '@roomote/db/server';
import {
  isRoomoteCloudEnabled,
  normalizeDeploymentComputeConfig,
  normalizeSetupNewState,
} from '@roomote/types';
import { isIP } from 'node:net';
import { z } from 'zod';

import { Env } from '@/lib/server/env';

import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

const ENROLLMENT_TOKEN_PATTERN = /^rce_[A-Za-z0-9_-]{43}$/u;
const CUSTOMER_HOSTED_ENV_VAR_NAMES = new Set([
  'ROOMOTE_CLOUD_URL',
  'ROOMOTE_CLOUD_DEPLOYMENT_TOKEN',
  'ROOMOTE_CLOUD_DEPLOYMENT_ID',
  'ROOMOTE_CLOUD_SHARED_SLACK_ENABLED',
  'ROOMOTE_CLOUD_SHARED_TEAMS_ENABLED',
  'ROOMOTE_CLOUD_INTEGRATION_SECRET',
  'R_GITHUB_APP_SLUG',
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_NAME',
  'R_TEAMS_BOT_OAUTH_SCOPE',
]);

const claimResponseSchema = z.object({
  deploymentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  deploymentSlug: z.string().min(1),
  endpointUrl: z.string().url(),
  manifest: z.object({
    hosting: z.object({ mode: z.literal('customer_hosted') }),
  }),
  environment: z.record(z.string(), z.string()),
});

export function parseRoomoteCloudEnrollmentLink(connectionLink: string): {
  cloudOrigin: string;
  connectionToken: string;
} {
  let url: URL;
  try {
    url = new URL(connectionLink.trim());
  } catch {
    throw new Error('Enter a valid Roomote Cloud connection link.');
  }
  const isLocalhost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.username ||
    url.password ||
    url.search ||
    (url.pathname !== '' && url.pathname !== '/') ||
    (!isLocalhost &&
      (isIP(url.hostname.replace(/^\[|\]$/gu, '')) !== 0 ||
        (url.port !== '' && url.port !== '443') ||
        url.hostname.endsWith('.local') ||
        url.hostname.endsWith('.internal'))) ||
    (url.protocol !== 'https:' &&
      !(
        process.env.NODE_ENV !== 'production' &&
        isLocalhost &&
        url.protocol === 'http:'
      ))
  ) {
    throw new Error('Enter a valid Roomote Cloud connection link.');
  }
  const connectionToken = new URLSearchParams(url.hash.slice(1)).get(
    'enrollment',
  );
  if (!connectionToken || !ENROLLMENT_TOKEN_PATTERN.test(connectionToken)) {
    throw new Error('The Roomote Cloud connection link is invalid or expired.');
  }
  return { cloudOrigin: url.origin, connectionToken };
}

function assertClaimResponse(
  claim: z.infer<typeof claimResponseSchema>,
  input: { cloudOrigin: string; endpointUrl: string },
) {
  const environment = claim.environment;
  const deploymentToken = environment.ROOMOTE_CLOUD_DEPLOYMENT_TOKEN;
  const teamsEnabled = environment.ROOMOTE_CLOUD_SHARED_TEAMS_ENABLED;
  if (
    new URL(claim.endpointUrl).origin !== input.endpointUrl ||
    environment.ROOMOTE_CLOUD_URL !== input.cloudOrigin ||
    environment.ROOMOTE_CLOUD_DEPLOYMENT_ID !== claim.deploymentId ||
    !/^rcd_[A-Za-z0-9_-]{43}$/u.test(deploymentToken ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/u.test(
      environment.ROOMOTE_CLOUD_INTEGRATION_SECRET ?? '',
    ) ||
    !['true', 'false'].includes(
      environment.ROOMOTE_CLOUD_SHARED_SLACK_ENABLED ?? '',
    ) ||
    !['true', 'false'].includes(teamsEnabled ?? '') ||
    environment.ROOMOTE_CLOUD_ENABLED !== 'true' ||
    environment.DEFAULT_COMPUTE_PROVIDER !== 'roomote-cloud' ||
    (environment.R_GITHUB_APP_SLUG !== undefined &&
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(environment.R_GITHUB_APP_SLUG))
  ) {
    throw new Error('Roomote Cloud returned an invalid enrollment response.');
  }
  if (teamsEnabled === 'true') {
    let teamsTokenUrl: URL;
    try {
      teamsTokenUrl = new URL(environment.R_TEAMS_BOT_TOKEN_ENDPOINT ?? '');
    } catch {
      throw new Error('Roomote Cloud returned an invalid enrollment response.');
    }
    if (
      !environment.R_TEAMS_BOT_APP_ID ||
      environment.R_TEAMS_BOT_APP_PASSWORD !== deploymentToken ||
      !environment.R_TEAMS_BOT_NAME ||
      !environment.R_TEAMS_BOT_OAUTH_SCOPE ||
      teamsTokenUrl.origin !== input.cloudOrigin ||
      teamsTokenUrl.pathname !== '/runtime/v1/integrations/teams/token' ||
      teamsTokenUrl.search ||
      teamsTokenUrl.hash
    ) {
      throw new Error('Roomote Cloud returned an invalid enrollment response.');
    }
  } else if (
    environment.R_TEAMS_BOT_APP_ID !== undefined ||
    environment.R_TEAMS_BOT_APP_PASSWORD !== undefined ||
    environment.R_TEAMS_BOT_TOKEN_ENDPOINT !== undefined ||
    environment.R_TEAMS_BOT_NAME !== undefined ||
    environment.R_TEAMS_BOT_OAUTH_SCOPE !== undefined
  ) {
    throw new Error('Roomote Cloud returned an invalid enrollment response.');
  }
}

async function getCloudError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > 256 * 1024) throw new Error('Response is too large.');
    const body = z.object({ error: z.string() }).parse(JSON.parse(text));
    return body.error;
  } catch {
    return 'Roomote Cloud could not connect this deployment.';
  }
}

async function parseClaimResponse(response: Response) {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 256 * 1024) {
    throw new Error('Roomote Cloud returned an invalid enrollment response.');
  }
  const text = await response.text();
  if (text.length > 256 * 1024) {
    throw new Error('Roomote Cloud returned an invalid enrollment response.');
  }
  try {
    return claimResponseSchema.parse(JSON.parse(text));
  } catch {
    throw new Error('Roomote Cloud returned an invalid enrollment response.');
  }
}

export async function enrollCustomerHostedRoomoteCommand(input: {
  connectionLink: string;
  actorUserId: string | null;
  fetchFn?: typeof fetch;
}) {
  if (!isRoomoteCloudEnabled(process.env)) {
    throw new Error('Roomote Cloud enrollment is not enabled.');
  }
  const { cloudOrigin, connectionToken } = parseRoomoteCloudEnrollmentLink(
    input.connectionLink,
  );
  const endpointUrl = new URL(Env.R_APP_URL).origin;
  let response: Response;
  try {
    response = await (input.fetchFn ?? fetch)(
      `${cloudOrigin}/enrollment/v1/claim`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ connectionToken, endpointUrl }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new Error(
      'Roomote could not reach Roomote Cloud. Check the connection link and try again.',
    );
  }
  if (!response.ok) throw new Error(await getCloudError(response));
  const claim = await parseClaimResponse(response);
  assertClaimResponse(claim, { cloudOrigin, endpointUrl });

  const values = Object.entries(claim.environment)
    .filter(
      ([name, value]) =>
        CUSTOMER_HOSTED_ENV_VAR_NAMES.has(name) && value.trim().length > 0,
    )
    .map(([name, value]) => ({ name, value }));

  await db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const setupNewState = normalizeSetupNewState({
      ...normalizeSetupNewState(settings?.setupNewState),
      computeProvider: 'roomote-cloud',
      lastInteractedByUserId: input.actorUserId,
    });
    const runtimeComputeConfig = normalizeDeploymentComputeConfig({
      defaultProvider: 'roomote-cloud',
      excludedProviders: ['modal', 'docker', 'daytona', 'e2b', 'blaxel'],
    });
    await upsertDeploymentEnvironmentVariables(tx, {
      userId: input.actorUserId,
      values,
    });
    await tx
      .insert(deploymentSettings)
      .values({ id: 'default', setupNewState, runtimeComputeConfig })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { setupNewState, runtimeComputeConfig, updatedAt: new Date() },
      });
  });
  invalidateTeamsBotRuntimeCredentialsCache();

  return {
    deploymentId: claim.deploymentId,
    workspaceId: claim.workspaceId,
    cloudUrl: cloudOrigin,
    endpointUrl,
  };
}
