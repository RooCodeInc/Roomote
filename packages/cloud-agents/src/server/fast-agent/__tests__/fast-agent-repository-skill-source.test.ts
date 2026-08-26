import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFastAgentRepositorySkillTree,
  RemoteFastAgentRepositorySkillSource,
  type RepositorySkillRepository,
  type RepositorySkillSnapshot,
} from '../fast-agent-repository-skill-source';

function repository(id: string, fullName: string): RepositorySkillRepository {
  return {
    cloneUrl: `https://example.test/${fullName}.git`,
    defaultBranch: 'main',
    environmentIds: ['environment-1'],
    fullName,
    githubRepoId: null,
    id,
    installationId: null,
    sourceControlProvider: 'gitlab',
  };
}

async function snapshot(
  sourceRepository: RepositorySkillRepository,
): Promise<RepositorySkillSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), 'fast-repo-skill-test-'));
  const id = `repository:${sourceRepository.id}:.agents/skills:release`;
  return {
    directory,
    records: [
      {
        description: 'Prepare a release.',
        environmentIds: sourceRepository.environmentIds,
        gitEnvironment: {},
        id,
        invocation: 'release',
        mainContent:
          '---\nname: release\ndescription: Prepare a release.\n---\n# Release',
        name: 'release',
        repository: sourceRepository.fullName,
        repositoryDirectory: directory,
        resources: new Map([
          [
            'SKILL.md',
            {
              byteLength: 65,
              path: '.agents/skills/release/SKILL.md',
              resource: 'SKILL.md',
            },
          ],
        ]),
        revision: 'abc123',
      },
    ],
  };
}

describe('RemoteFastAgentRepositorySkillSource', () => {
  it('accepts only bounded regular Markdown blobs from repository trees', () => {
    const tree = [
      '100644 blob aaaaaa 120\t.agents/skills/release/SKILL.md',
      '100755 blob bbbbbb 50\t.agents/skills/release/references/guide.md',
      '100644 blob cccccc 40\t.agents/skills/release/script.ts',
      '120000 blob dddddd 20\t.agents/skills/release/linked.md',
      '160000 commit eeeeee -\t.agents/skills/release/vendor.md',
      '100644 blob ffffff 9000000\t.agents/skills/release/huge.md',
      '',
    ].join('\0');

    expect(parseFastAgentRepositorySkillTree(tree)).toEqual([
      expect.objectContaining({ path: '.agents/skills/release/SKILL.md' }),
      expect.objectContaining({
        path: '.agents/skills/release/references/guide.md',
      }),
    ]);
  });

  it('lists scoped skills, qualifies collisions, and loads only cataloged IDs', async () => {
    const repositories = [
      repository('repo-1', 'acme/one'),
      repository('repo-2', 'acme/two'),
    ];
    const directories: string[] = [];
    const source = new RemoteFastAgentRepositorySkillSource({
      allowedEnvironmentIds: ['environment-1'],
      resolveRepositories: vi.fn().mockResolvedValue(repositories),
      loadSnapshot: async (value) => {
        const loaded = await snapshot(value);
        directories.push(loaded.directory);
        return loaded;
      },
    });

    const catalog = await source.list({ environmentId: 'environment-1' });

    expect(catalog).toMatchObject({ warnings: [] });
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        invocation: 'acme-one.release',
        repository: 'acme/one',
      }),
      expect.objectContaining({
        invocation: 'acme-two.release',
        repository: 'acme/two',
      }),
    ]);
    await expect(
      source.read('repository:repo-1:.agents/skills:release'),
    ).resolves.toMatchObject({
      content: expect.stringContaining('# Release'),
      repository: 'acme/one',
      resource: 'SKILL.md',
    });
    await expect(source.read('repository:repo-3:unknown')).rejects.toThrow(
      'Unknown skill resource.',
    );
    await expect(
      source.list({ environmentId: 'unknown-environment' }),
    ).rejects.toThrow('Unknown Fast environment.');
    await expect(
      source.list({ repositoryId: 'repo-1' }),
    ).resolves.toMatchObject({
      skills: [expect.objectContaining({ repository: 'acme/one' })],
    });
    await expect(
      source.list({ repositoryId: 'unknown-repository' }),
    ).rejects.toThrow('Unknown Fast repository.');

    await source.dispose();
    for (const directory of directories) {
      await expect(access(directory)).rejects.toThrow();
    }
  });

  it('reports repositories that cannot be inspected without hiding other skills', async () => {
    const repositories = [
      repository('repo-1', 'acme/one'),
      repository('repo-2', 'acme/two'),
    ];
    const source = new RemoteFastAgentRepositorySkillSource({
      allowedEnvironmentIds: ['environment-1'],
      resolveRepositories: vi.fn().mockResolvedValue(repositories),
      loadSnapshot: async (value) => {
        if (value.id === 'repo-1') throw new Error('unavailable');
        return snapshot(value);
      },
    });

    const catalog = await source.list({ environmentId: 'environment-1' });

    expect(catalog.skills).toEqual([
      expect.objectContaining({ repository: 'acme/two' }),
    ]);
    expect(catalog.warnings).toEqual([
      'Repository skills could not be inspected for acme/one.',
    ]);
    await source.dispose();
  });
});
