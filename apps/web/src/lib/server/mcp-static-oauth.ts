import { MCP_INTEGRATIONS, type McpIntegration } from '@roomote/types';

type StaticOauthClientEnv = NonNullable<McpIntegration['oauthClientEnv']>;
type StaticOauthPairResolution =
  | {
      status: 'configured';
      values: Record<string, string>;
    }
  | {
      status: 'missing' | 'partial';
    };

export type StaticOauthReadiness =
  | 'not_required'
  | 'ready'
  | 'missing'
  | 'partial';

const STATIC_OAUTH_FALLBACKS: Partial<Record<string, StaticOauthClientEnv[]>> =
  {};

const STATIC_OAUTH_ENV_PAIRS = MCP_INTEGRATIONS.flatMap((integration) => {
  const clientIdEnv = integration.oauthClientEnv?.clientIdEnv;
  const clientSecretEnv = integration.oauthClientEnv?.clientSecretEnv;

  return clientIdEnv && clientSecretEnv
    ? [[clientIdEnv, clientSecretEnv] as const]
    : [];
});

const STATIC_OAUTH_ENV_KEYS = new Set(
  STATIC_OAUTH_ENV_PAIRS.flatMap(([clientIdEnv, clientSecretEnv]) => [
    clientIdEnv,
    clientSecretEnv,
  ]),
);

const STATIC_OAUTH_ENV_PARTNERS = Object.fromEntries(
  STATIC_OAUTH_ENV_PAIRS.flatMap(([clientIdEnv, clientSecretEnv]) => [
    [clientIdEnv, clientSecretEnv],
    [clientSecretEnv, clientIdEnv],
  ]),
);

export function getStaticOauthEnvPartnerKey(key: string): string | undefined {
  return STATIC_OAUTH_ENV_PARTNERS[key];
}

function getNonEmptyEnvString(
  env: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveStaticOauthPair(
  env: unknown,
  firstKey: string,
  secondKey?: string,
): StaticOauthPairResolution {
  if (typeof env !== 'object' || env === null) {
    return { status: 'missing' };
  }

  if (!STATIC_OAUTH_ENV_KEYS.has(firstKey)) {
    return { status: 'missing' };
  }

  const envRecord = env as Record<string, unknown>;
  const plainFirstValue = getNonEmptyEnvString(envRecord, firstKey);
  const plainSecondValue = secondKey
    ? getNonEmptyEnvString(envRecord, secondKey)
    : undefined;

  if (plainFirstValue || plainSecondValue) {
    if (plainFirstValue && (!secondKey || plainSecondValue)) {
      return {
        status: 'configured',
        values: {
          [firstKey]: plainFirstValue,
          ...(secondKey && plainSecondValue
            ? { [secondKey]: plainSecondValue }
            : {}),
        },
      };
    }

    return { status: 'partial' };
  }

  return { status: 'missing' };
}

export function resolveStaticOauthEnvValue(
  env: unknown,
  key: string,
): string | undefined {
  const partnerKey = STATIC_OAUTH_ENV_PARTNERS[key];
  if (!partnerKey) {
    return undefined;
  }

  const resolution = resolveStaticOauthPair(env, key, partnerKey);
  if (resolution.status !== 'configured') {
    return undefined;
  }

  return resolution.values[key];
}

function resolveStaticOauthCandidateInformation(
  env: unknown,
  candidate: StaticOauthClientEnv,
) {
  const resolution = resolveStaticOauthPair(
    env,
    candidate.clientIdEnv,
    candidate.clientSecretEnv,
  );

  if (resolution.status !== 'configured') {
    return resolution;
  }

  const clientId = resolution.values[candidate.clientIdEnv];
  const clientSecret = candidate.clientSecretEnv
    ? resolution.values[candidate.clientSecretEnv]
    : undefined;

  if (!clientId || (candidate.clientSecretEnv && !clientSecret)) {
    return { status: 'partial' as const };
  }

  return {
    status: 'configured' as const,
    client_id: clientId,
    client_secret: clientSecret,
    token_endpoint_auth_method:
      candidate.tokenEndpointAuthMethod ??
      (candidate.clientSecretEnv ? 'client_secret_post' : 'none'),
  };
}

function getStaticOauthEnvCandidates(
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
): StaticOauthClientEnv[] {
  if (!integration.oauthClientEnv) {
    return [];
  }

  return [
    integration.oauthClientEnv,
    ...(STATIC_OAUTH_FALLBACKS[integration.id] ?? []),
  ];
}

export function getStaticOauthEnvKeys(
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
): string[] {
  return Array.from(
    new Set(
      getStaticOauthEnvCandidates(integration).flatMap((candidate) => [
        candidate.clientIdEnv,
        ...(candidate.clientSecretEnv ? [candidate.clientSecretEnv] : []),
      ]),
    ),
  );
}

function resolveStaticOauthIntegration(
  env: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
) {
  for (const candidate of getStaticOauthEnvCandidates(integration)) {
    const candidateInformation = resolveStaticOauthCandidateInformation(
      env,
      candidate,
    );

    if (candidateInformation.status === 'configured') {
      return candidateInformation;
    }

    if (candidateInformation.status === 'partial') {
      return candidateInformation;
    }
  }

  return { status: 'missing' as const };
}

export function resolveStaticOauthClientInformation(
  env: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
) {
  const resolution = resolveStaticOauthIntegration(env, integration);

  if (resolution.status !== 'configured') {
    return undefined;
  }

  return {
    client_id: resolution.client_id,
    client_secret: resolution.client_secret,
    token_endpoint_auth_method: resolution.token_endpoint_auth_method,
  };
}

export function getStaticOauthReadiness(
  env: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
): StaticOauthReadiness {
  const candidates = getStaticOauthEnvCandidates(integration);

  if (candidates.length === 0) {
    return 'not_required';
  }

  const resolution = resolveStaticOauthIntegration(env, integration);

  return resolution.status === 'configured' ? 'ready' : resolution.status;
}
