import * as fs from 'fs';

import {
  isCredentialWriteBarrierEngaged,
  resetCredentialWriteBarrierForTesting,
} from '../../lib/credential-write-barrier';

import { scrubSandboxSecretsBeforeSnapshot } from './scrub-sandbox-secrets';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  return {
    ...actual,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();

  return {
    ...actual,
    homedir: vi.fn(() => '/home/testuser'),
  };
});

const COMMON_ENV_PATH = '/home/testuser/.roomote/env.sh';

const EXPECTED_REMOVED_PATHS = [
  '/home/testuser/.roomote/gh-token',
  '/home/testuser/.roomote/source-control-repository-credentials.tsv',
  '/home/testuser/.roomote/gitlab-token',
  '/home/testuser/.roomote/gitlab-repository-credentials.tsv',
  '/home/testuser/.local/share/opencode/auth.json',
  '/home/testuser/.local/share/opencode/google-application-credentials.json',
];

function findWrite(path: string) {
  return [...vi.mocked(fs.writeFileSync).mock.calls]
    .reverse()
    .find((call) => call[0] === path);
}

describe('scrubSandboxSecretsBeforeSnapshot', () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCredentialWriteBarrierForTesting();
    delete process.env.XDG_DATA_HOME;
  });

  afterAll(() => {
    if (originalXdgDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('rewrites the common env file without any env var exports', async () => {
    await scrubSandboxSecretsBeforeSnapshot();

    const write = findWrite(COMMON_ENV_PATH);
    expect(write).toBeDefined();

    const content = String(write?.[1]);
    const exportLines = content
      .split('\n')
      .filter((line) => line.trim().startsWith('export '));

    // Only scaffolding survives: the recursion guard and the gh wrapper PATH
    // prepend. No deployment env vars (inference keys, etc.) remain.
    for (const line of exportLines) {
      expect(line).toMatch(/export (__ROOMOTE_ENV_LOADED|PATH)=/);
    }
  });

  it('removes git tokens and OpenCode credential files', async () => {
    await scrubSandboxSecretsBeforeSnapshot();

    for (const path of EXPECTED_REMOVED_PATHS) {
      expect(fs.rmSync).toHaveBeenCalledWith(path, { force: true });
    }
  });

  it('respects XDG_DATA_HOME when locating OpenCode credential files', async () => {
    process.env.XDG_DATA_HOME = '/custom/data';

    await scrubSandboxSecretsBeforeSnapshot();

    expect(fs.rmSync).toHaveBeenCalledWith('/custom/data/opencode/auth.json', {
      force: true,
    });
    expect(fs.rmSync).toHaveBeenCalledWith(
      '/custom/data/opencode/google-application-credentials.json',
      { force: true },
    );
  });

  it('uses the task runtime home for OpenCode credentials', async () => {
    await scrubSandboxSecretsBeforeSnapshot(undefined, {
      homeDir: '/workspace/.roomote-runtime-home',
      runtimeEnv: {},
    });

    expect(fs.rmSync).toHaveBeenCalledWith(
      '/workspace/.roomote-runtime-home/.local/share/opencode/auth.json',
      { force: true },
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      '/workspace/.roomote-runtime-home/.local/share/opencode/google-application-credentials.json',
      { force: true },
    );
  });

  it('uses task-specific XDG_DATA_HOME for OpenCode credentials', async () => {
    await scrubSandboxSecretsBeforeSnapshot(undefined, {
      homeDir: '/workspace/.roomote-runtime-home',
      runtimeEnv: { XDG_DATA_HOME: '/task/data' },
    });

    expect(fs.rmSync).toHaveBeenCalledWith('/task/data/opencode/auth.json', {
      force: true,
    });
  });

  it('continues scrubbing, warns, and reports the failed step when a step fails', async () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const logger = { info: vi.fn(), warn: vi.fn() };

    const { failedSteps } = await scrubSandboxSecretsBeforeSnapshot(logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
    expect(failedSteps).toEqual(['rewrite common env file without env vars']);

    // Later steps still ran despite the env-file failure.
    for (const path of EXPECTED_REMOVED_PATHS) {
      expect(fs.rmSync).toHaveBeenCalledWith(path, { force: true });
    }
  });

  it('reports no failed steps on success', async () => {
    const { failedSteps } = await scrubSandboxSecretsBeforeSnapshot();

    expect(failedSteps).toEqual([]);
  });

  it('engages the credential write barrier before scrubbing', async () => {
    expect(isCredentialWriteBarrierEngaged()).toBe(false);

    await scrubSandboxSecretsBeforeSnapshot();

    expect(isCredentialWriteBarrierEngaged()).toBe(true);
  });
});
