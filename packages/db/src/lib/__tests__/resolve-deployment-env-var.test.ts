const { mockDecryptSecrets } = vi.hoisted(() => ({
  mockDecryptSecrets: vi.fn(),
}));

vi.mock('../encryption', () => ({
  decryptSecrets: (...args: unknown[]) => mockDecryptSecrets(...args),
}));

import { resolveDeploymentEnvVar } from '../environment-variables';

type Executor = NonNullable<Parameters<typeof resolveDeploymentEnvVar>[1]>;

type EnvVarRow = { name: string; value: string };

function makeExecutor(rows: EnvVarRow[]): Executor {
  return {
    query: {
      environmentVariables: {
        findMany: vi.fn(async () => rows),
      },
    },
  } as unknown as Executor;
}

describe('resolveDeploymentEnvVar', () => {
  const originalToken = process.env.GITLAB_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptSecrets.mockImplementation(async (value) => value);
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITLAB_TOKEN;
    } else {
      process.env.GITLAB_TOKEN = originalToken;
    }
  });

  it('returns the process env value first when present', async () => {
    process.env.GITLAB_TOKEN = 'runtime-token';
    const executor = makeExecutor([
      { name: 'GITLAB_TOKEN', value: 'db-token' },
    ]);

    const result = await resolveDeploymentEnvVar('GITLAB_TOKEN', executor);

    expect(result).toBe('runtime-token');
    expect(executor.query.environmentVariables.findMany).not.toHaveBeenCalled();
  });

  it('falls back to the encrypted deployment env var when process env is absent', async () => {
    delete process.env.GITLAB_TOKEN;
    mockDecryptSecrets.mockResolvedValue('db-token');
    const executor = makeExecutor([
      { name: 'GITLAB_TOKEN', value: 'encrypted-blob' },
    ]);

    const result = await resolveDeploymentEnvVar('GITLAB_TOKEN', executor);

    expect(result).toBe('db-token');
    expect(executor.query.environmentVariables.findMany).toHaveBeenCalled();
    expect(mockDecryptSecrets).toHaveBeenCalledWith('encrypted-blob');
  });

  it('returns null when neither process env nor a saved row exists', async () => {
    delete process.env.GITLAB_TOKEN;
    const executor = makeExecutor([]);

    const result = await resolveDeploymentEnvVar('GITLAB_TOKEN', executor);

    expect(result).toBeNull();
  });

  it('returns null when the saved value is empty', async () => {
    delete process.env.GITLAB_TOKEN;
    mockDecryptSecrets.mockResolvedValue('   ');
    const executor = makeExecutor([
      { name: 'GITLAB_TOKEN', value: 'encrypted-blob' },
    ]);

    const result = await resolveDeploymentEnvVar('GITLAB_TOKEN', executor);

    expect(result).toBeNull();
  });
});
