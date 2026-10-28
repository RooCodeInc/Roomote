import { resolveBrainSettingsStatus } from './brain-settings-status';

const ready = {
  configured: true,
  url: 'http://gbrain:8931',
  embeddingsAvailable: true,
  corpusReachable: true,
  provisioned: true,
};

describe('resolveBrainSettingsStatus', () => {
  it('is incomplete without embeddings, even when Memory is on', () => {
    const result = resolveBrainSettingsStatus({
      ...ready,
      embeddingsAvailable: false,
      corpusReachable: false,
    });

    expect(result.status).toBe('incomplete');
    expect(result.statusDetail).toMatch(/no embeddings provider/);
  });

  it('does not warn about embeddings when Cloudflare or another embedder is ready', () => {
    const result = resolveBrainSettingsStatus({
      ...ready,
      embeddingsAvailable: true,
      corpusReachable: true,
    });

    expect(result).toEqual({ status: 'connected', statusDetail: null });
  });

  it('is not_configured when Memory is off', () => {
    expect(
      resolveBrainSettingsStatus({ ...ready, configured: false }).status,
    ).toBe('not_configured');
  });
});
