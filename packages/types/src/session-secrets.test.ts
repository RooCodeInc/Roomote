import {
  isSessionSecretToolsExperimentEnabled,
  SESSION_SECRET_TOOLS_EXPERIMENT_KEY,
  sessionSecretPrepareSchema,
} from './session-secrets';
import { isSessionEgressCredentialHeaderName } from './session-egress';

describe('Session secret tools experiment', () => {
  it('uses a stable identifier and defaults off', () => {
    expect(SESSION_SECRET_TOOLS_EXPERIMENT_KEY).toBe(
      'session_secret_tools_enabled',
    );
    expect(isSessionSecretToolsExperimentEnabled(undefined)).toBe(false);
    expect(isSessionSecretToolsExperimentEnabled({})).toBe(false);
  });

  it('enables only for an explicit boolean true', () => {
    expect(
      isSessionSecretToolsExperimentEnabled({
        session_secret_tools_enabled: true,
      }),
    ).toBe(true);
    expect(
      isSessionSecretToolsExperimentEnabled({
        session_secret_tools_enabled: 'true',
      }),
    ).toBe(false);
  });
});

describe('credential header names', () => {
  const prepare = (headerName: string, headerPrefix = '') =>
    sessionSecretPrepareSchema.safeParse({
      label: 'Example',
      origin: 'https://api.example.com',
      headerName,
      headerPrefix,
    });

  it('accepts the standard slots and any service-specific token, lowercased', () => {
    for (const [given, stored] of [
      ['authorization', 'authorization'],
      ['X-API-Key', 'x-api-key'],
      ['api-key', 'api-key'],
      ['PRIVATE-TOKEN', 'private-token'],
      ['x-shopify-access-token', 'x-shopify-access-token'],
      ['apikey', 'apikey'],
      [' X-Vault-Token ', 'x-vault-token'],
    ] as const) {
      const parsed = prepare(given);
      expect(parsed.success, given).toBe(true);
      if (parsed.success) expect(parsed.data.headerName).toBe(stored);
    }
  });

  it('refuses headers that shape or route the request', () => {
    for (const name of [
      'cookie',
      'host',
      'content-type',
      'content-length',
      'transfer-encoding',
      'proxy-authorization',
      'x-forwarded-for',
      'sec-fetch-mode',
      'accept-encoding',
      'user-agent',
      'set-cookie',
      '',
      'bad header',
      'x-' + 'a'.repeat(70),
      ':authority',
      'toke/n',
    ]) {
      expect(isSessionEgressCredentialHeaderName(name), name).toBe(false);
      expect(prepare(name).success, name).toBe(false);
    }
  });
});
