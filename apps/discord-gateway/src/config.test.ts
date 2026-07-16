import { resolveDiscordGatewayConfig } from './config';

describe('resolveDiscordGatewayConfig', () => {
  it('preserves an API path prefix', () => {
    expect(
      resolveDiscordGatewayConfig({
        TRPC_URL: 'https://roomote.example/_roomote-api/',
        PORT: '13003',
      }),
    ).toMatchObject({
      apiEventsUrl:
        'https://roomote.example/_roomote-api/api/internal/discord/events',
      port: 13003,
    });
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
