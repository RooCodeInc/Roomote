import {
  isServiceCredentialToolsExperimentEnabled,
  SERVICE_CREDENTIAL_TOOLS_EXPERIMENT_KEY,
  serviceCredentialPrepareSchema,
  hasLeadingIntegrationSavedBlock,
  stripLeadingIntegrationSavedBlock,
  serviceCredentialPrepareToolSchema,
  integrationCreateSchema,
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

describe('integration visibility', () => {
  it('defaults new approvals and Settings integrations to the deployment', () => {
    const prepared = serviceCredentialPrepareSchema.parse({
      label: 'Example',
      origin: 'https://api.example.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
    });
    expect(prepared.visibility).toBe('deployment');
    expect(
      integrationCreateSchema.parse({
        ...prepared,
        secret: 'disposable-key',
      }).visibility,
    ).toBe('deployment');
  });

  it('accepts owner-only as an explicit opt-out', () => {
    expect(
      serviceCredentialPrepareToolSchema.parse({
        label: 'Example',
        origin: 'https://api.example.com',
        headerName: 'authorization',
        visibility: 'owner',
      }).visibility,
    ).toBe('owner');
  });
});

describe('integration saved block', () => {
  const envelope =
    '<integration_saved>\nhidden instruction\n</integration_saved>\nI added the integration, go ahead.';

  it('strips exactly the leading block and keeps the visible text', () => {
    expect(hasLeadingIntegrationSavedBlock(envelope)).toBe(true);
    expect(stripLeadingIntegrationSavedBlock(envelope)).toBe(
      'I added the integration, go ahead.',
    );
    expect(stripLeadingIntegrationSavedBlock(`  ${envelope}`)).toBe(
      'I added the integration, go ahead.',
    );
  });

  it('leaves ordinary human text alone, even when it quotes the tag', () => {
    for (const text of [
      'plain text',
      'Please render <integration_saved>example</integration_saved> verbatim',
      '<integration_saved>unclosed',
      '<integration_saved>a</integration_saved> then <integration_saved>b</integration_saved>',
    ]) {
      expect(stripLeadingIntegrationSavedBlock(text)).toBe(
        text ===
          '<integration_saved>a</integration_saved> then <integration_saved>b</integration_saved>'
          ? 'then <integration_saved>b</integration_saved>'
          : text,
      );
    }
    expect(hasLeadingIntegrationSavedBlock('plain text')).toBe(false);
    expect(hasLeadingIntegrationSavedBlock('<integration_saved>unclosed')).toBe(
      false,
    );
  });

  it('costs one scan on adversarial input', () => {
    const hostile = '<integration_saved>'.repeat(10_000) + 'x'.repeat(100_000);
    const started = performance.now();
    expect(stripLeadingIntegrationSavedBlock(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('normalizes a header prefix typed without its trailing space', () => {
    const base = {
      label: 'Postman Echo',
      origin: 'https://postman-echo.com',
      headerName: 'authorization',
    };
    expect(
      serviceCredentialPrepareToolSchema.parse({
        ...base,
        headerPrefix: 'Basic',
      }).headerPrefix,
    ).toBe('Basic ');
    expect(
      serviceCredentialPrepareToolSchema.parse({
        ...base,
        headerPrefix: 'Bearer ',
      }).headerPrefix,
    ).toBe('Bearer ');
    expect(serviceCredentialPrepareToolSchema.parse(base).headerPrefix).toBe(
      '',
    );
  });
});
