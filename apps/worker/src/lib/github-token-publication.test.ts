import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import * as fs from 'fs';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => state.home,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe('source-control credential publication', () => {
  let actualFs: typeof import('fs');
  let credentials: typeof import('./github-token');

  beforeEach(async () => {
    vi.resetModules();
    actualFs = await vi.importActual('fs');
    vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    state.home = actualFs.mkdtempSync('/tmp/roomote-publication-test-');
    credentials = await import('./github-token');
    credentials.ensureGitCredentialHelper();
    await credentials.applySourceControlTokenMetadata({
      envVars: { GH_TOKEN: 'old-primary' },
      gitCredentials: [
        {
          host: 'github.com',
          repositoryFullName: 'secondary/project',
          username: 'x-access-token',
          token: 'old-secondary',
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    actualFs.rmSync(state.home, { recursive: true, force: true });
  });

  function readNativeCredential(repository: string): string {
    return execFileSync(
      'bash',
      [join(state.home, '.roomote/git-credential-roomote.sh'), 'get'],
      {
        input: `protocol=https\nhost=github.com\npath=${repository}\n\n`,
        encoding: 'utf8',
        env: { HOME: state.home, PATH: process.env.PATH },
      },
    );
  }

  it.each([
    ['gh-token', 'primary/project', 'old-primary', 'new-primary'],
    [
      'source-control-repository-credentials.tsv',
      'secondary/project',
      'old-secondary',
      'new-secondary',
    ],
  ])(
    'keeps native readers on the previous complete %s until publication',
    async (name, repository, previous, next) => {
      let observed = false;
      vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
        if (typeof file !== 'string' || !file.includes(name)) {
          return actualFs.writeFileSync(file, data, options);
        }
        // Pause at the actual truncate/create boundary while a separate Bash
        // process reads the live path. It must still see the prior generation.
        const flags = typeof options === 'object' ? options?.flag : undefined;
        const fd = actualFs.openSync(file, flags ?? 'w', 0o600);
        try {
          observed = true;
          expect(readNativeCredential(repository)).toContain(
            `password=${previous}\n`,
          );
          actualFs.writeFileSync(fd, data, options);
        } finally {
          actualFs.closeSync(fd);
        }
      });

      await credentials.applySourceControlTokenMetadata({
        envVars: { GH_TOKEN: 'new-primary' },
        gitCredentials: [
          {
            host: 'github.com',
            repositoryFullName: 'secondary/project',
            username: 'x-access-token',
            token: 'new-secondary',
          },
        ],
      });

      expect(observed).toBe(true);
      expect(readNativeCredential(repository)).toContain(`password=${next}\n`);
      expect(
        actualFs.statSync(join(state.home, '.roomote', name)).mode & 0o777,
      ).toBe(0o600);
      expect(
        actualFs
          .readdirSync(join(state.home, '.roomote'))
          .filter((file) => file.endsWith('.tmp')),
      ).toEqual([]);
    },
  );

  it('preserves previous credentials and removes unpublished material after rename failure', () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('publication failed');
    });
    expect(() => credentials.writeGitHubTokenFile('new-primary')).toThrow(
      'publication failed',
    );
    expect(readNativeCredential('primary/project')).toContain(
      'password=old-primary\n',
    );
    expect(
      actualFs
        .readdirSync(join(state.home, '.roomote'))
        .filter((file) => file.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('scrubs published credential files for snapshots', () => {
    credentials.removeSourceControlCredentialFiles();
    expect(readNativeCredential('primary/project')).toBe('');
    expect(readNativeCredential('secondary/project')).toBe('');
    expect(
      actualFs
        .readdirSync(join(state.home, '.roomote'))
        .filter((file) => file.endsWith('.tmp')),
    ).toEqual([]);
  });
});
