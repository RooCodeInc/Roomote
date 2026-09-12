const { config, enabled } = vi.hoisted(() => ({
  config: vi.fn(),
  enabled: { value: false },
}));
vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();
  return {
    ...actual,
    Env: new Proxy(actual.Env, {
      get(target, key) {
        return key === 'R_HTTP_INTEGRATIONS_ENABLED'
          ? enabled.value
          : Reflect.get(target, key);
      },
    }),
  };
});
vi.mock('./broker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./broker')>()),
  loadHttpIntegrationsConfig: config,
}));

let directory: string;
const validManifest = JSON.stringify([
  {
    id: 'example',
    description: 'Operator test integration',
    origin: 'https://api.example.com',
    rules: [{ method: 'GET', pathPrefix: '/items' }],
    credential: { header: 'authorization', valueEnv: 'HTTP_MOUNT_TEST_TOKEN' },
  },
]);
beforeEach(() => {
  vi.resetModules();
  enabled.value = false;
  config.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'session-broker-config-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('keeps the Session broker mounted without loading operator configuration when disabled', async () => {
  const { mcp } = await import('../index');
  expect(
    mcp.routes.some((route) => route.path.includes('http-integrations')),
  ).toBe(true);
  expect(config).not.toHaveBeenCalled();
  expect(
    (await mcp.request('/http-integrations', { method: 'POST' })).status,
  ).toBe(401);
}, 30_000);

it('fails before enabled route registration if configuration is missing', async () => {
  enabled.value = true;
  vi.stubEnv('R_HTTP_INTEGRATIONS_CONFIG_PATH', undefined);
  const actual = await vi.importActual<typeof import('./broker')>('./broker');
  config.mockImplementation(actual.loadHttpIntegrationsConfig);
  await expect(import('../index')).rejects.toThrow(
    'HTTP integrations requires R_HTTP_INTEGRATIONS_CONFIG_PATH',
  );
});

it.each(['malformed JSON', 'invalid manifest'])(
  'fails closed at enabled mount with real loader for %s, without a dynamic-only fallback',
  async (kind) => {
    enabled.value = true;
    const manifest = join(directory, 'manifest.json');
    writeFileSync(
      manifest,
      kind === 'malformed JSON' ? '{invalid-test-marker' : '[]',
    );
    vi.stubEnv('R_HTTP_INTEGRATIONS_CONFIG_PATH', manifest);
    const actual = await vi.importActual<typeof import('./broker')>('./broker');
    config.mockImplementation(actual.loadHttpIntegrationsConfig);
    await expect(import('../index')).rejects.toThrow(
      'Invalid HTTP integrations configuration: check integration manifest',
    );
    expect(config).toHaveBeenCalledOnce();
  },
);

it.each(['valid', 'invalid'])(
  'does not read a %s operator manifest when only dynamic grants are enabled',
  async (kind) => {
    const manifest = join(directory, 'manifest.json');
    writeFileSync(
      manifest,
      kind === 'valid' ? validManifest : '{invalid-test-marker',
    );
    vi.stubEnv('R_HTTP_INTEGRATIONS_CONFIG_PATH', manifest);
    const actual = await vi.importActual<typeof import('./broker')>('./broker');
    config.mockImplementation(actual.loadHttpIntegrationsConfig);
    const { mcp } = await import('../index');
    expect(
      mcp.routes.some((route) => route.path.includes('http-integrations')),
    ).toBe(true);
    expect(config).not.toHaveBeenCalled();
  },
);

it('loads operator configuration once at enabled mount, not on each request', async () => {
  enabled.value = true;
  const manifest = join(directory, 'manifest.json');
  writeFileSync(manifest, validManifest);
  vi.stubEnv('R_HTTP_INTEGRATIONS_CONFIG_PATH', manifest);
  const actual = await vi.importActual<typeof import('./broker')>('./broker');
  config.mockImplementation(actual.loadHttpIntegrationsConfig);
  const { mcp } = await import('../index');
  expect(config).toHaveBeenCalledOnce();
  writeFileSync(manifest, '{changed-after-mount');
  for (let i = 0; i < 2; i++) {
    expect(
      (await mcp.request('/http-integrations', { method: 'POST' })).status,
    ).toBe(401);
  }
  expect(config).toHaveBeenCalledOnce();
});
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
