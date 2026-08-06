import {
  addSourceControlOAuthResult,
  normalizeSourceControlOAuthReturnTarget,
  resolveSourceControlOAuthReturnTarget,
  SOURCE_CONTROL_SETTINGS_PATH,
  SOURCE_CONTROL_SETUP_PATH,
} from './source-control-oauth-redirect';

describe('source-control OAuth redirect handling', () => {
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
});
