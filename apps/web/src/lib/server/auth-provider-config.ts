import type { DatabaseOrTransaction } from '@roomote/db/server';
import { db, resolveEffectiveDeploymentEnvVars } from '@roomote/db/server';
import {
  SETUP_AUTH_PROVIDER_CATALOG,
  type SetupAuthProviderId,
} from '@roomote/types';

import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';
import { Env } from './env';

export type ResolvedAuthProviderConfig = {
  enabledProviders: SetupAuthProviderId[];
  slackClientId: string | null;
  slackClientSecret: string | null;
  microsoftClientId: string | null;
  microsoftClientSecret: string | null;
  microsoftTenantId: string | null;
  gitlabClientId: string | null;
  gitlabClientSecret: string | null;
  gitlabBaseUrl: string | null;
  giteaClientId: string | null;
  giteaClientSecret: string | null;
  giteaBaseUrl: string | null;
  bitbucketClientId: string | null;
  bitbucketClientSecret: string | null;
  bitbucketBaseUrl: string | null;
  adoClientId: string | null;
  adoClientSecret: string | null;
  adoTenantId: string | null;
  adoOrganization: string | null;
  adoBaseUrl: string | null;
  signature: string;
};

function readConfiguredValue(
  runtimeEnv: Partial<Record<string, string | undefined>>,
  deploymentEnvVars: Record<string, string>,
  key: string,
): string | undefined {
  const runtimeValue = runtimeEnv[key]?.trim();

  if (runtimeValue) {
    return runtimeValue;
  }

  const deploymentValue = deploymentEnvVars[key]?.trim();

  if (deploymentValue) {
    return deploymentValue;
  }

  return undefined;
}

export async function resolveAuthProviderConfig(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    deploymentEnvVars?: Record<string, string>;
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<ResolvedAuthProviderConfig> {
  if (!options.deploymentEnvVars && !options.executor) {
    await bootstrapWebRuntimeEnv();
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const deploymentEnvVars =
    options.deploymentEnvVars ??
    (await resolveEffectiveDeploymentEnvVars({ executor }));

  const slackClientId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'R_SLACK_CLIENT_ID') ??
    null;
  const slackClientSecret =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'R_SLACK_CLIENT_SECRET',
    ) ?? null;
  const microsoftClientId =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'R_MICROSOFT_CLIENT_ID',
    ) ?? null;
  const microsoftClientSecret =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'R_MICROSOFT_CLIENT_SECRET',
    ) ?? null;
  const microsoftTenantId =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'R_MICROSOFT_TENANT_ID',
    ) ?? null;
  const gitlabClientId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'GITLAB_CLIENT_ID') ??
    null;
  const gitlabClientSecret =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'GITLAB_CLIENT_SECRET',
    ) ?? null;
  const gitlabBaseUrl =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'GITLAB_BASE_URL') ??
    null;
  const giteaClientId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'GITEA_CLIENT_ID') ??
    null;
  const giteaClientSecret =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'GITEA_CLIENT_SECRET') ??
    null;
  const giteaBaseUrl =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'GITEA_BASE_URL') ??
    null;
  const bitbucketClientId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'BITBUCKET_CLIENT_ID') ??
    null;
  const bitbucketClientSecret =
    readConfiguredValue(
      runtimeEnv,
      deploymentEnvVars,
      'BITBUCKET_CLIENT_SECRET',
    ) ?? null;
  const bitbucketBaseUrl =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'BITBUCKET_BASE_URL') ??
    null;
  const adoClientId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'ADO_CLIENT_ID') ??
    microsoftClientId;
  const adoClientSecret =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'ADO_CLIENT_SECRET') ??
    microsoftClientSecret;
  const adoTenantId =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'ADO_TENANT_ID') ??
    microsoftTenantId;
  const adoOrganization =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'ADO_ORGANIZATION') ??
    null;
  const adoBaseUrl =
    readConfiguredValue(runtimeEnv, deploymentEnvVars, 'ADO_BASE_URL') ?? null;

  const enabledProviders = SETUP_AUTH_PROVIDER_CATALOG.filter((provider) =>
    provider.id === 'slack'
      ? Boolean(slackClientId && slackClientSecret)
      : Boolean(
          microsoftClientId && microsoftClientSecret && microsoftTenantId,
        ),
  ).map((provider) => provider.id);

  return {
    enabledProviders,
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
    signature: JSON.stringify({
      enabledProviders,
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
      roomoteAllowedEmails: Env.R_ALLOWED_EMAILS ?? null,
      roomoteAppUrl: Env.R_APP_URL,
    }),
  };
}
