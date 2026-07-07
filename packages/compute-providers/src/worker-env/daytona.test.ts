import { buildDaytonaWorkerEnv } from './daytona';

describe('buildDaytonaWorkerEnv', () => {
  it('forwards daytona compute metadata into the worker env', () => {
    const env = buildDaytonaWorkerEnv({
      authToken: 'auth-token',
      snapshotName: 'roomote-worker',
      deploymentSlug: 'roomote',
      environmentId: 'env_123',
    });

    expect(env.COMPUTE_PROVIDER).toBe('daytona');
    expect(env.ROOMOTE_WORKER_COMPUTE_PROVIDER).toBe('daytona');
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT).toBe('roomote-worker');
    expect(env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND).toBe('base-image');
    expect(env.ROOMOTE_WORKER_DEPLOYMENT_SLUG).toBe('roomote');
    expect(env.ROOMOTE_WORKER_ENVIRONMENT_ID).toBe('env_123');
  });
});
