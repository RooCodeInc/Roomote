import { describe, expect, it } from 'vitest';

import {
  CUSTOM_MCP_SERVER_NAME_PATTERN,
  HTTP_INTEGRATIONS_MCP_ID,
  RESERVED_CUSTOM_MCP_SERVER_NAMES,
  customMcpServerCreateInputSchema,
  customMcpServerInputSchema,
  isInternalMcpServer,
  validateCustomMcpHeaderName,
  validateCustomMcpServerUrl,
} from '../custom-mcp-servers';
import { MCP_INTEGRATIONS } from '../mcp-oauth';

const validServer = {
  transport: 'remote' as const,
  name: 'internal-tools',
  url: 'https://mcp.example.com/mcp',
  authType: 'static_headers' as const,
  headers: { 'x-api-key': 'secret-value' },
};

describe('isInternalMcpServer', () => {
  it('recognizes Roomote infrastructure and nothing else', () => {
    expect(isInternalMcpServer('roomote')).toBe(true);
    expect(isInternalMcpServer('_roomote_http_integrations')).toBe(true);
    expect(isInternalMcpServer('gbrain')).toBe(true);
    // In-process catalog integrations still count as external.
    expect(isInternalMcpServer('notion')).toBe(false);
    expect(isInternalMcpServer('granola')).toBe(false);
    expect(isInternalMcpServer('linear')).toBe(false);
    // Memory-category catalog entries are deployment integrations too.
    expect(isInternalMcpServer('supermemory')).toBe(false);
  });

  it('keeps the HTTP integrations broker structurally collision-free', () => {
    // Its flattened native keys start with `_`, and no governable server
    // name can produce a key like that: custom names reject a leading
    // underscore and every catalog id starts alphanumeric.
    expect(HTTP_INTEGRATIONS_MCP_ID.startsWith('_')).toBe(true);
    expect(CUSTOM_MCP_SERVER_NAME_PATTERN.test('_anything')).toBe(false);
    expect(
      MCP_INTEGRATIONS.some((integration) => integration.id.startsWith('_')),
    ).toBe(false);
  });

  it('rejects new custom names that could collide with internal tool keys', () => {
    // OpenCode flattens tools to `<server>_<tool>`, so `gbrain_get` / `page`
    // would share `gbrain_get_page` with the Brain's own `get_page`.
    for (const name of ['gbrain_get', 'roomote_manage']) {
      const result = customMcpServerCreateInputSchema.safeParse({
        ...validServer,
        name,
      });
      expect(result.success).toBe(false);
    }
    // Merely similar names that cannot collide stay valid.
    expect(
      customMcpServerCreateInputSchema.safeParse({
        ...validServer,
        name: 'gbrain-reports',
      }).success,
    ).toBe(true);
    expect(
      customMcpServerCreateInputSchema.safeParse({
        ...validServer,
        name: 'linear_x',
      }).success,
    ).toBe(true);
  });

  it('lets the update path keep a legacy internal-prefixed name', () => {
    // Names are immutable, so an update always carries the existing name;
    // rejecting it would lock the row out of every other edit. Legacy rows
    // are excluded at mount time instead.
    expect(
      customMcpServerInputSchema.safeParse({
        ...validServer,
        name: 'gbrain_get',
      }).success,
    ).toBe(true);
  });
});

describe('customMcpServerInputSchema', () => {
  it('accepts a valid static-header server', () => {
    expect(customMcpServerInputSchema.safeParse(validServer).success).toBe(
      true,
    );
  });

  it('keeps http-integrations valid for existing custom servers', () => {
    expect(RESERVED_CUSTOM_MCP_SERVER_NAMES.has('http-integrations')).toBe(
      false,
    );
    expect(
      customMcpServerInputSchema.safeParse({
        ...validServer,
        name: 'http-integrations',
      }).success,
    ).toBe(true);
  });

  it('accepts a no-auth server without headers', () => {
    const result = customMcpServerInputSchema.safeParse({
      transport: 'remote',
      name: 'public-server',
      url: 'https://mcp.example.com',
      authType: 'none',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a stdio server', () => {
    const result = customMcpServerInputSchema.safeParse({
      transport: 'stdio',
      name: 'local-tools',
      stdio: {
        command: 'npx',
        args: ['-y', '@example/mcp-server'],
        env: { EXAMPLE_TOKEN: '${MY_DEPLOYMENT_VAR}' },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects reserved env references in stdio config', () => {
    const result = customMcpServerInputSchema.safeParse({
      transport: 'stdio',
      name: 'local-tools',
      stdio: {
        command: 'npx',
        env: { TOKEN: '{env:ROOMOTE_CLOUD_TOKEN}' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects client credentials on non-oauth servers', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      manualClientId: 'client-1',
    });

    expect(result.success).toBe(false);
  });

  it('rejects headers on a non-header auth type', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      authType: 'none',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    'roomote',
    'sentry',
    'linear',
    'github',
    'slack',
    'notion',
    'gbrain',
    '_roomote_http_integrations',
  ])('rejects reserved name %s', (name) => {
    expect(RESERVED_CUSTOM_MCP_SERVER_NAMES.has(name)).toBe(true);

    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      name,
    });

    expect(result.success).toBe(false);
  });

  it.each([
    'Uppercase',
    '-leading-dash',
    'has space',
    'has/slash',
    'a'.repeat(65),
  ])('rejects invalid name %s', (name) => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      name,
    });

    expect(result.success).toBe(false);
  });

  it.each([
    'ftp://mcp.example.com',
    'file:///etc/passwd',
    'https://user:pass@mcp.example.com',
    'not-a-url',
  ])('rejects URL %s', (url) => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      url,
    });

    expect(result.success).toBe(false);
  });

  it('rejects reserved env references in header values', () => {
    for (const value of [
      'Bearer ${ROOMOTE_CLOUD_TOKEN}',
      'Bearer {env:ROOMOTE_CLOUD_TOKEN}',
      '$AUTH_TOKEN',
      '{env:JOB_AUTH_PRIVATE_KEY}',
    ]) {
      const result = customMcpServerInputSchema.safeParse({
        ...validServer,
        headers: { 'x-api-key': value },
      });

      expect(result.success, value).toBe(false);
    }
  });

  it('rejects reserved env references in the URL', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      url: 'https://mcp.example.com/{env:ROOMOTE_CLOUD_TOKEN}',
    });

    expect(result.success).toBe(false);
  });

  it('allows operator-defined env references', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      headers: { 'x-api-key': '${MY_OWN_SECRET}' },
    });

    expect(result.success).toBe(true);
  });
});

describe('validateCustomMcpHeaderName', () => {
  it.each(['Host', 'mcp-session-id', 'Cookie'])(
    'denies proxy-managed header %s',
    (name) => {
      expect(validateCustomMcpHeaderName(name)).not.toBeNull();
    },
  );

  // Authorization is allowed on purpose: static bearer API keys are the
  // common auth scheme for remote MCP servers, headers are restricted to the
  // static_headers mode, and the proxy never forwards the caller's run token.
  it.each([
    'x-api-key',
    'X-Custom-Token',
    'api-version',
    'authorization',
    'Authorization',
  ])('allows custom header %s', (name) => {
    expect(validateCustomMcpHeaderName(name)).toBeNull();
  });

  it('rejects header names with illegal characters', () => {
    expect(validateCustomMcpHeaderName('bad header')).not.toBeNull();
    expect(validateCustomMcpHeaderName('bad:header')).not.toBeNull();
  });
});

describe('validateCustomMcpServerUrl', () => {
  it('accepts plain http for self-hosted internal servers', () => {
    expect(validateCustomMcpServerUrl('http://mcp.internal:8080/mcp')).toBe(
      null,
    );
  });
});

describe('header value validation', () => {
  it('rejects CR/LF injection in header values', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      headers: { 'x-api-key': 'value\r\nx-injected: 1' },
    });

    expect(result.success).toBe(false);
  });

  it('allows tabs and normal printable values', () => {
    const result = customMcpServerInputSchema.safeParse({
      ...validServer,
      headers: { 'x-api-key': 'value with spaces\tand tab' },
    });

    expect(result.success).toBe(true);
  });
});
