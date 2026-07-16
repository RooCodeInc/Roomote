import { resolveDiscordGatewayConfig } from './config';

describe('resolveDiscordGatewayConfig', () => {
  it('preserves an API path prefix and prefers the dedicated secret', () => {
    expect(
      resolveDiscordGatewayConfig({
        TRPC_URL: 'https://roomote.example/_roomote-api/',
        R_DISCORD_GATEWAY_SECRET: 'discord-secret',
        ENCRYPTION_KEY: 'fallback-key',
        PORT: '13003',
      }),
    ).toMatchObject({
      apiEventsUrl:
        'https://roomote.example/_roomote-api/api/internal/discord/events',
      apiSecret: 'discord-secret',
      port: 13003,
    });
  });

  it('uses ENCRYPTION_KEY only as a local-development fallback', () => {
    expect(
      resolveDiscordGatewayConfig({
        ENCRYPTION_KEY: 'shared-key',
        R_APP_ENV: 'development',
      }).apiSecret,
    ).toBe('shared-key');
  });

  it('does not accept ENCRYPTION_KEY under production-like config', () => {
    expect(
      resolveDiscordGatewayConfig({
        ENCRYPTION_KEY: 'shared-key',
        R_APP_ENV: 'production',
      }).apiSecret,
    ).toBeNull();
  });

  it('does not accept ENCRYPTION_KEY under preview config', () => {
    expect(
      resolveDiscordGatewayConfig({
        ENCRYPTION_KEY: 'shared-key',
        R_APP_ENV: 'preview',
      }).apiSecret,
    ).toBeNull();
  });

  it('supports bounded delivery and login retry tuning', () => {
    expect(
      resolveDiscordGatewayConfig({
        DISCORD_GATEWAY_DELIVERY_MAX_ATTEMPTS: '4',
        DISCORD_GATEWAY_DELIVERY_MAX_BACKOFF_MS: '12000',
        DISCORD_GATEWAY_LOGIN_RETRY_BASE_MS: '30000',
        DISCORD_GATEWAY_LOGIN_RETRY_MAX_MS: '600000',
      }),
    ).toMatchObject({
      deliveryMaxAttempts: 4,
      deliveryMaxBackoffMs: 12_000,
      loginRetryBaseMs: 30_000,
      loginRetryMaxMs: 600_000,
    });
  });
});
