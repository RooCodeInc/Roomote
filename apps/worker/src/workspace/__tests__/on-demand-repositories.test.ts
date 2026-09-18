import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildRepositoriesManifest,
  discoverClonedRepositoryPaths,
  pageOnDemandRepositories,
  resolveOnDemandRepositoryPath,
  shouldRegisterCloneRepositoryTool,
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

describe('shouldRegisterCloneRepositoryTool', () => {
  it('registers only when setup stamped an authorized checkout scope', () => {
    expect(
      shouldRegisterCloneRepositoryTool({
        ROOMOTE_ON_DEMAND_REPOSITORIES: 'true',
      }),
    ).toBe(true);
    expect(shouldRegisterCloneRepositoryTool({})).toBe(false);
    expect(
      shouldRegisterCloneRepositoryTool({
        ROOMOTE_ON_DEMAND_REPOSITORIES: 'false',
      }),
    ).toBe(false);
  });
});

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
    expect(manifest).toContain(
      'This file is a snapshot. The `list_repositories` tool reads the same repositories live',
    );
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

describe('pageOnDemandRepositories', () => {
  const catalog: OnDemandRepository[] = [
    {
      fullName: 'octo/Widgets',
      sourceControlProvider: 'github',
      defaultBranch: 'trunk',
      description: `Handles | invoices\n${'x'.repeat(200)}`,
      private: true,
    },
    {
      fullName: 'acme/app',
      sourceControlProvider: 'gitlab',
      defaultBranch: 'main',
      description: null,
      private: false,
    },
    {
      fullName: 'acme/app',
      sourceControlProvider: 'github',
      defaultBranch: 'main',
      description: null,
      private: false,
    },
  ];

  it('orders by name then provider and reports checkout state', () => {
    const page = pageOnDemandRepositories({
      repositories: catalog,
      clonedPaths: { 'octo/Widgets': '/repos/octo/Widgets' },
      limit: 50,
    });

    expect(
      page.repositories.map((repository) => [
        repository.fullName,
        repository.sourceControlProvider,
        repository.checkedOut,
      ]),
    ).toEqual([
      ['acme/app', 'github', false],
      ['acme/app', 'gitlab', false],
      ['octo/Widgets', 'github', true],
    ]);
    expect(page.repositories[2]).toMatchObject({
      path: '/repos/octo/Widgets',
      defaultBranch: 'trunk',
      private: true,
    });
    // JSON output keeps the pipe unescaped, unlike the Markdown manifest.
    expect(page.repositories[2]?.description).toMatch(
      /^Handles \| invoices x+…$/,
    );
    expect(page.repositories[2]?.description).toHaveLength(160);
    expect(page.repositories[0]).not.toHaveProperty('description');
    expect(page.repositories[0]).not.toHaveProperty('path');
    expect(page).toMatchObject({ totalCount: 3 });
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('matches every term case-insensitively and pages the matches', () => {
    const search = (query: string) =>
      pageOnDemandRepositories({
        repositories: catalog,
        clonedPaths: {},
        query,
        limit: 50,
      }).repositories.map((repository) => repository.fullName);

    expect(search('WIDGETS invoices')).toEqual(['octo/Widgets']);
    expect(search('widgets acme')).toEqual([]);

    const first = pageOnDemandRepositories({
      repositories: catalog,
      clonedPaths: {},
      query: 'acme',
      limit: 1,
    });
    expect(first).toMatchObject({ totalCount: 2, nextOffset: 1 });
    const last = pageOnDemandRepositories({
      repositories: catalog,
      clonedPaths: {},
      query: 'acme',
      limit: 1,
      offset: 1,
    });
    expect(last.repositories).toHaveLength(1);
    expect(last).not.toHaveProperty('nextOffset');
  });
});
