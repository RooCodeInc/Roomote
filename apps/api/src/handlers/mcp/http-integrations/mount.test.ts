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

it('does not register or load configuration when disabled', async () => {
  const { mcp } = await import('../index');
  expect(
    mcp.routes.some((route) => route.path.includes('http-integrations')),
  ).toBe(false);
  expect(config).not.toHaveBeenCalled();
  expect(
    (await mcp.request('/http-integrations', { method: 'POST' })).status,
  ).toBe(404);
}, 30_000);

it('fails before enabled route registration if configuration is missing', async () => {
  vi.resetModules();
  enabled.value = true;
  config.mockImplementation(() => {
    throw new Error(
      'HTTP integrations requires R_HTTP_INTEGRATIONS_CONFIG_PATH',
    );
  });
  await expect(import('../index')).rejects.toThrow(
    'HTTP integrations requires R_HTTP_INTEGRATIONS_CONFIG_PATH',
  );
});
