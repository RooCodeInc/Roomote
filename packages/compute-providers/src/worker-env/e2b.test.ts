import { buildE2bWorkerEnv } from './e2b';

describe('buildE2bWorkerEnv', () => {
  it('forwards e2b compute metadata into the worker env', () => {
    const env = buildE2bWorkerEnv({
      authToken: 'auth-token',
      templateId: 'roomote-worker',
      deploymentSlug: 'roomote',
      environmentId: 'env_123',
    });

    expect(env.COMPUTE_PROVIDER).toBe('e2b');
    expect(env.ROOMOTE_WORKER_COMPUTE_PROVIDER).toBe('e2b');
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT).toBe('roomote-worker');
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND).toBe('base-image');
    expect(env.ROOMOTE_WORKER_DEPLOYMENT_SLUG).toBe('roomote');
    expect(env.ROOMOTE_WORKER_ENVIRONMENT_ID).toBe('env_123');
  });
});
