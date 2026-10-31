afterEach(() => vi.unstubAllGlobals());

it('uses the upgraded library social sign-in and explicit linking endpoints', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      url: 'https://provider.example.test/authorize',
      redirect: false,
    }),
  );
  vi.stubGlobal('fetch', fetch);
  vi.resetModules();
  const { authClient } = await import('./auth-client');
  await authClient.signIn.social({
    provider: 'microsoft-entra-id',
    callbackURL: '/sessions',
    disableRedirect: true,
  });
  await authClient.linkSocial({
    provider: 'gitlab',
    callbackURL: '/settings/personal',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    '/api/auth/sign-in/social',
  );
  expect(String(fetch.mock.calls[1]?.[0])).toContain('/api/auth/link-social');
});
