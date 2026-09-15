import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildRepositoriesManifest,
  discoverClonedRepositoryPaths,
  resolveOnDemandRepositoryPath,
  writeRepositoriesManifest,
  type OnDemandRepository,
} from '../on-demand-repositories';

const repositories: OnDemandRepository[] = [
  {
    fullName: 'acme/web',
    sourceControlProvider: 'github',
    defaultBranch: 'main',
    description: 'Marketing site | with a pipe \\| and slash\nand a newline',
    private: false,
  },
  {
    fullName: 'acme/api',
    sourceControlProvider: 'github',
    defaultBranch: 'develop',
    description: null,
    private: true,
  },
  {
    fullName: 'acme/long',
    sourceControlProvider: 'gitlab',
    defaultBranch: 'main',
    description: 'x'.repeat(400),
    private: false,
  },
];

function createWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'on-demand-repositories-'));
}

describe('resolveOnDemandRepositoryPath', () => {
  it('rejects names that escape the workspace root', () => {
    expect(resolveOnDemandRepositoryPath('/repos', '../etc')).toBeUndefined();
    expect(resolveOnDemandRepositoryPath('/repos', '')).toBeUndefined();
    expect(resolveOnDemandRepositoryPath('/repos', 'acme/api')).toBe(
      path.join('/repos', 'acme', 'api'),
    );
  });
});

describe('discoverClonedRepositoryPaths', () => {
  it('returns only repositories that already have a git checkout', () => {
    const workspaceRoot = createWorkspaceRoot();
    fs.mkdirSync(path.join(workspaceRoot, 'acme', 'api', '.git'), {
      recursive: true,
    });
    // A directory without .git (interrupted clone) is not a checkout.
    fs.mkdirSync(path.join(workspaceRoot, 'acme', 'web'), { recursive: true });

    expect(discoverClonedRepositoryPaths(workspaceRoot, repositories)).toEqual({
      'acme/api': path.join(workspaceRoot, 'acme', 'api'),
    });
  });
});

describe('buildRepositoriesManifest', () => {
  it('lists checked-out repositories first and sanitizes descriptions', () => {
    const manifest = buildRepositoriesManifest({
      workspaceRoot: '/repos',
      repositories,
      clonedPaths: { 'acme/web': '/repos/acme/web' },
    });
    const rows = manifest
      .split('\n')
      .filter((line) => line.startsWith('| `acme/'));

    expect(manifest).toContain(
      '3 repositories are available to this task; 1 is checked out.',
    );
    expect(manifest).toContain('`clone_repository`');
    expect(rows).toEqual([
      '| `acme/web` | yes (`/repos/acme/web`) | `main` | public | Marketing site \\| with a pipe \\\\\\| and slash and a newline |',
      '| `acme/api` | no | `develop` | private |  |',
      `| \`acme/long\` | no | \`main\` | public | ${'x'.repeat(159)}… |`,
    ]);
  });
});

describe('writeRepositoriesManifest', () => {
  it('writes REPOSITORIES.md at the workspace root', () => {
    const workspaceRoot = path.join(createWorkspaceRoot(), 'nested');

    const manifestPath = writeRepositoriesManifest({
      workspaceRoot,
      repositories,
      clonedPaths: {},
    });

    expect(manifestPath).toBe(path.join(workspaceRoot, 'REPOSITORIES.md'));
    expect(fs.readFileSync(manifestPath, 'utf8')).toContain('# Repositories');
  });
});
