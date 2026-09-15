import {
  isServiceCredentialToolsExperimentEnabled,
  SERVICE_CREDENTIAL_TOOLS_EXPERIMENT_KEY,
  serviceCredentialPrepareSchema,
  hasIntegrationSavedBlock,
  stripIntegrationSavedBlocks,
} from './service-credentials';
import { isCredentialEgressCredentialHeaderName } from './credential-egress';

describe('integration keys experiment', () => {
  it('uses a stable identifier and defaults off', () => {
    expect(SERVICE_CREDENTIAL_TOOLS_EXPERIMENT_KEY).toBe(
      'integration_keys_enabled',
    );
    expect(isServiceCredentialToolsExperimentEnabled(undefined)).toBe(false);
    expect(isServiceCredentialToolsExperimentEnabled({})).toBe(false);
  });

  it('enables only for an explicit boolean true', () => {
    expect(
      isServiceCredentialToolsExperimentEnabled({
        integration_keys_enabled: true,
      }),
    ).toBe(true);
    expect(
      isServiceCredentialToolsExperimentEnabled({
        integration_keys_enabled: 'true',
      }),
    ).toBe(false);
  });
});

describe('credential header names', () => {
  const prepare = (headerName: string, headerPrefix = '') =>
    serviceCredentialPrepareSchema.safeParse({
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
      expect(isCredentialEgressCredentialHeaderName(name), name).toBe(false);
      expect(prepare(name).success, name).toBe(false);
    }
  });
});

describe('integration saved block', () => {
  it('strips every block and keeps the visible text', () => {
    const text =
      '<integration_saved>\nhidden instruction\n</integration_saved>\nI added the integration, go ahead.';
    expect(hasIntegrationSavedBlock(text)).toBe(true);
    expect(stripIntegrationSavedBlocks(text)).toBe(
      'I added the integration, go ahead.',
    );
    expect(hasIntegrationSavedBlock('plain text')).toBe(false);
    expect(stripIntegrationSavedBlocks('plain text')).toBe('plain text');
  });
});
