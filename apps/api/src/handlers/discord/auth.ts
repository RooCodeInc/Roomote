import { timingSafeEqual } from 'node:crypto';

import { Env } from '@roomote/env';

const DISCORD_GATEWAY_SECRET_HEADER =
  'x-roomote-discord-gateway-secret' as const;

type DiscordGatewayAuthError = {
  error:
    | 'discord_gateway_secret_not_configured'
    | 'discord_gateway_unauthorized';
  status: 503 | 401;
};

/**
 * ENCRYPTION_KEY fallback is local-dev only. Production and preview must set a
 * dedicated `R_DISCORD_GATEWAY_SECRET` so a leaked transport header cannot
 * unlock the vault that encrypts stored secrets.
 */
function allowsEncryptionKeyFallback(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const appEnv = (
    processEnv.R_APP_ENV ||
    processEnv.APP_ENV ||
    Env.APP_ENV
  )?.trim();
  if (appEnv === 'development') {
    return true;
  }
  if (appEnv === 'production' || appEnv === 'preview') {
    return false;
  }
  const nodeEnv = (processEnv.NODE_ENV || Env.NODE_ENV)?.trim();
  return nodeEnv === 'development';
}

function configuredGatewaySecret(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const dedicated = processEnv.R_DISCORD_GATEWAY_SECRET?.trim();
  if (dedicated) {
    return dedicated;
  }

  if (!allowsEncryptionKeyFallback(processEnv)) {
    return null;
  }

  return (
    Env.ENCRYPTION_KEY?.trim() || processEnv.ENCRYPTION_KEY?.trim() || null
  );
}

function secretsMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function verifyDiscordGatewaySecret(
  received: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): DiscordGatewayAuthError | null {
  const expected = configuredGatewaySecret(processEnv);
  if (!expected) {
    return {
      error: 'discord_gateway_secret_not_configured',
      status: 503,
    };
  }
  if (!received || !secretsMatch(expected, received.trim())) {
    return { error: 'discord_gateway_unauthorized', status: 401 };
  }
  return null;
}

export { DISCORD_GATEWAY_SECRET_HEADER };
