import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveDiscordGatewaySecret: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  resolveDiscordGatewaySecret: mocks.resolveDiscordGatewaySecret,
}));

import { verifyDiscordGatewaySecret } from '../auth';

describe('verifyDiscordGatewaySecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDiscordGatewaySecret.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts the dedicated gateway secret', async () => {
    mocks.resolveDiscordGatewaySecret.mockResolvedValue('gateway-secret');

    await expect(
      verifyDiscordGatewaySecret('gateway-secret'),
    ).resolves.toBeNull();
  });

  it('rejects a wrong dedicated gateway secret', async () => {
    mocks.resolveDiscordGatewaySecret.mockResolvedValue('gateway-secret');

    await expect(verifyDiscordGatewaySecret('wrong-secret')).resolves.toEqual({
      error: 'discord_gateway_unauthorized',
      status: 401,
    });
  });

  it('does not accept ENCRYPTION_KEY as the gateway secret', async () => {
    mocks.resolveDiscordGatewaySecret.mockResolvedValue(null);

    await expect(
      verifyDiscordGatewaySecret(
        'production-encryption-key-that-is-long-enough',
      ),
    ).resolves.toEqual({
      error: 'discord_gateway_secret_not_configured',
      status: 503,
    });
  });

  it('returns 503 when the dedicated secret is unset', async () => {
    mocks.resolveDiscordGatewaySecret.mockResolvedValue(null);

    await expect(verifyDiscordGatewaySecret(undefined)).resolves.toEqual({
      error: 'discord_gateway_secret_not_configured',
      status: 503,
    });
  });
});
