import { buildBlaxelWorkerEnv } from './blaxel';

describe('buildBlaxelWorkerEnv', () => {
  it('uses the image user home so mise activates the baked toolchain', () => {
    const env = buildBlaxelWorkerEnv({
      authToken: 'auth-token',
      image: 'sandbox/roomote-worker:version',
      deploymentSlug: 'roomote',
      environmentId: 'env_123',
    });

    expect(env).toMatchObject({
      COMPUTE_PROVIDER: 'blaxel',
      HOME: '/home/roomote',
      MISE_DATA_DIR: '/opt/mise',
      MISE_CACHE_DIR: '/opt/mise/cache',
      ROOMOTE_WORKER_COMPUTE_FINGERPRINT: 'sandbox/roomote-worker:version',
      ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND: 'base-image',
    });
  });
});
