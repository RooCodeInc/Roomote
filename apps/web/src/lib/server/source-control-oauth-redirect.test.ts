import {
  addSourceControlOAuthResult,
  buildSetupSessionSourceControlReturnTarget,
  normalizeSourceControlOAuthReturnTarget,
  resolveSourceControlOAuthReturnTarget,
  SOURCE_CONTROL_SETTINGS_PATH,
  SOURCE_CONTROL_SETUP_PATH,
} from './source-control-oauth-redirect';

describe('source-control OAuth redirect handling', () => {
  it.each([
    '/\\evil.example',
    '/%2f%2fevil.example',
    '/%5cevil.example',
    '/%252f%252fevil.example',
    '/\nevil.example',
    '/%00evil.example',
  ])('rejects unsafe return %s', (target) => {
    expect(normalizeSourceControlOAuthReturnTarget(target)).toBeNull();
  });
  it.each([true, false])(
    'preserves a generic Session request when setupOpen=%s',
    (setupOpen) => {
      const target =
        '/sessions/11111111-1111-4111-8111-111111111111?connectionRequest=22222222-2222-4222-8222-222222222222';
      expect(
        resolveSourceControlOAuthReturnTarget({
          requestedTarget: target,
          setupOpen,
        }),
      ).toBe(target);
      expect(
        addSourceControlOAuthResult(target, 'gitlab', 'connected'),
      ).not.toContain('sync=1');
    },
  );
  it('defaults incomplete setup flows to the source-control step', () => {
    expect(
      resolveSourceControlOAuthReturnTarget({
        setupOpen: true,
      }),
    ).toBe(SOURCE_CONTROL_SETUP_PATH);
  });

  it('never returns a completed deployment to setup', () => {
    expect(
      resolveSourceControlOAuthReturnTarget({
        setupOpen: false,
        requestedTarget: '/setup?step=source-control-connect',
      }),
    ).toBe(SOURCE_CONTROL_SETTINGS_PATH);
  });

  it('rejects external OAuth return targets', () => {
    expect(
      normalizeSourceControlOAuthReturnTarget('https://evil.example'),
    ).toBe(null);
    expect(normalizeSourceControlOAuthReturnTarget('//evil.example')).toBe(
      null,
    );
  });

  it('preserves settings queries without adding a setup sync marker', () => {
    expect(
      addSourceControlOAuthResult(
        '/settings/source-control?tab=source-control',
        'gitea',
        'connected',
      ),
    ).toBe('/settings/source-control?tab=source-control&gitea=connected');
  });

  it('adds the sync marker only for setup returns', () => {
    expect(
      addSourceControlOAuthResult(
        SOURCE_CONTROL_SETUP_PATH,
        'gitlab',
        'connected',
      ),
    ).toBe('/setup?step=source-control-connect&gitlab=connected&sync=1');
  });

  it('builds a provider-preserving setup Session return target', () => {
    const target = buildSetupSessionSourceControlReturnTarget({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'gitlab',
    });

    expect(target).toBe(
      '/sessions/11111111-1111-4111-8111-111111111111?setup=source-control&provider=gitlab',
    );
    expect(addSourceControlOAuthResult(target, 'gitlab', 'connected')).toBe(
      '/sessions/11111111-1111-4111-8111-111111111111?setup=source-control&provider=gitlab&gitlab=connected&sync=1',
    );
  });

  it('preserves first-party provider errors on the setup Session return', () => {
    const target = buildSetupSessionSourceControlReturnTarget({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'gitea',
    });
    expect(
      addSourceControlOAuthResult(
        target,
        'gitea',
        'error',
        'The user cancelled authorization.',
      ),
    ).toContain('reason=The+user+cancelled+authorization.');
  });
});
