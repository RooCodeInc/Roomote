import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  APP_ENV: 'production' as string | undefined,
  NODE_ENV: 'test' as string | undefined,
  ENCRYPTION_KEY: 'production-encryption-key-that-is-long-enough',
  R_DISCORD_GATEWAY_SECRET: undefined as string | undefined,
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));

import { verifyDiscordGatewaySecret } from '../auth';

describe('verifyDiscordGatewaySecret', () => {
  const previousEnv = {
    R_DISCORD_GATEWAY_SECRET: process.env.R_DISCORD_GATEWAY_SECRET,
    R_APP_ENV: process.env.R_APP_ENV,
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  };

  beforeEach(() => {
    envMock.APP_ENV = 'production';
    envMock.NODE_ENV = 'test';
    envMock.ENCRYPTION_KEY = 'production-encryption-key-that-is-long-enough';
    envMock.R_DISCORD_GATEWAY_SECRET = undefined;
    delete process.env.R_DISCORD_GATEWAY_SECRET;
    delete process.env.R_APP_ENV;
    delete process.env.APP_ENV;
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('accepts the dedicated gateway secret', () => {
    process.env.R_DISCORD_GATEWAY_SECRET = 'gateway-secret';

    expect(verifyDiscordGatewaySecret('gateway-secret')).toBeNull();
  });

  it('rejects a wrong dedicated gateway secret', () => {
    process.env.R_DISCORD_GATEWAY_SECRET = 'gateway-secret';

    expect(verifyDiscordGatewaySecret('wrong-secret')).toEqual({
      error: 'discord_gateway_unauthorized',
      status: 401,
    });
  });

  it('does not accept ENCRYPTION_KEY in production-like config', () => {
    envMock.APP_ENV = 'production';
    envMock.ENCRYPTION_KEY = 'production-encryption-key-that-is-long-enough';
    process.env.R_APP_ENV = 'production';

    expect(
      verifyDiscordGatewaySecret(
        'production-encryption-key-that-is-long-enough',
      ),
    ).toEqual({
      error: 'discord_gateway_secret_not_configured',
      status: 503,
    });
  });

  it('does not accept ENCRYPTION_KEY in preview', () => {
    envMock.APP_ENV = 'preview';
    process.env.R_APP_ENV = 'preview';

    expect(
      verifyDiscordGatewaySecret(
        'production-encryption-key-that-is-long-enough',
      ),
    ).toEqual({
      error: 'discord_gateway_secret_not_configured',
      status: 503,
    });
  });

  it('falls back to ENCRYPTION_KEY only in local development', () => {
    envMock.APP_ENV = 'development';
    envMock.ENCRYPTION_KEY = 'local-encryption-key-that-is-long-enough';
    process.env.R_APP_ENV = 'development';

    expect(
      verifyDiscordGatewaySecret('local-encryption-key-that-is-long-enough'),
    ).toBeNull();
  });

  it('prefers the dedicated secret over ENCRYPTION_KEY in development', () => {
    envMock.APP_ENV = 'development';
    envMock.ENCRYPTION_KEY = 'local-encryption-key-that-is-long-enough';
    process.env.R_APP_ENV = 'development';
    process.env.R_DISCORD_GATEWAY_SECRET = 'gateway-secret';

    expect(verifyDiscordGatewaySecret('gateway-secret')).toBeNull();
    expect(
      verifyDiscordGatewaySecret('local-encryption-key-that-is-long-enough'),
    ).toEqual({
      error: 'discord_gateway_unauthorized',
      status: 401,
    });
  });
});
