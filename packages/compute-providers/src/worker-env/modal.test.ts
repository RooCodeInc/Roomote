import { buildModalWorkerEnv } from './modal';

describe('buildModalWorkerEnv', () => {
  it('forwards modal compute metadata into the worker env', () => {
    const env = buildModalWorkerEnv({
      authToken: 'auth-token',
      baseImageRef: 'ghcr.io/roomote/modal-worker:test',
      deploymentSlug: 'roomote',
      environmentId: 'env_123',
    });

    expect(env.COMPUTE_PROVIDER).toBe('modal');
    expect(env.ROOMOTE_WORKER_COMPUTE_PROVIDER).toBe('modal');
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT).toBe(
      'ghcr.io/roomote/modal-worker:test',
    );
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND).toBe('base-image');
    expect(env.ROOMOTE_WORKER_DEPLOYMENT_SLUG).toBe('roomote');
    expect(env.ROOMOTE_WORKER_ENVIRONMENT_ID).toBe('env_123');
  });
});
