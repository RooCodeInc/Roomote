import { timingSafeEqual } from 'node:crypto';

import { resolveDiscordGatewaySecret } from '@roomote/db/server';

const DISCORD_GATEWAY_SECRET_HEADER =
  'x-roomote-discord-gateway-secret' as const;

type DiscordGatewayAuthError = {
  error:
    | 'discord_gateway_secret_not_configured'
    | 'discord_gateway_unauthorized';
  status: 503 | 401;
};

function secretsMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export async function verifyDiscordGatewaySecret(
  received: string | undefined,
): Promise<DiscordGatewayAuthError | null> {
  const expected = await resolveDiscordGatewaySecret();
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
