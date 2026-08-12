import { buildBoxWorkerEnv } from './box';

describe('buildBoxWorkerEnv', () => {
  it('builds Box worker context without exposing provider credentials', () => {
    const env = buildBoxWorkerEnv({
      authToken: 'worker-auth-token',
      machineType: 'performance',
      deploymentSlug: 'roomote',
      environmentId: 'env_123',
    });

    expect(env).toMatchObject({
      COMPUTE_PROVIDER: 'box',
      ROOMOTE_WORKER_COMPUTE_PROVIDER: 'box',
      ROOMOTE_WORKER_COMPUTE_FINGERPRINT: 'performance',
      ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND: 'runtime',
      HOME: '/home/user',
    });
    expect(JSON.stringify(env)).not.toContain('BOX_API');
  });
});
