import { resolveEffectivePreviewRuntimeConfig } from './preview-runtime-config';

describe('resolveEffectivePreviewRuntimeConfig', () => {
  const deploymentEnvVars = {
    PREVIEW_PROXY_BASE_URL: 'https://preview.example.com',
    PREVIEW_PROXY_SUBDOMAIN_SUFFIX: '.preview.example.com',
  };

  it('uses the persisted flat preview hostname suffix when no runtime override exists', async () => {
    const resolved = await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: {},
      deploymentEnvVars,
    });

    expect(resolved.persisted.previewProxySubdomainSuffix).toBe(
      '.preview.example.com',
    );
    expect(resolved.effective.previewProxySubdomainSuffix).toBe(
      '.preview.example.com',
    );
    expect(resolved.overrideState).toEqual({
      hasOverrides: false,
      overriddenFields: [],
    });
  });

  it('reports a runtime flat preview hostname suffix override', async () => {
    const resolved = await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: {
        PREVIEW_PROXY_SUBDOMAIN_SUFFIX: '.runtime-preview.example.com',
      },
      deploymentEnvVars,
    });

    expect(resolved.effective.previewProxySubdomainSuffix).toBe(
      '.runtime-preview.example.com',
    );
    expect(resolved.overrideState).toEqual({
      hasOverrides: true,
      overriddenFields: ['previewProxySubdomainSuffix'],
    });
  });
});
