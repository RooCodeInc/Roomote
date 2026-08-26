import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  FAST_AGENT_PACKAGED_SKILL_NAMES,
  FastAgentSkillStore,
} from '../fast-agent-skill-store';

describe('FastAgentSkillStore', () => {
  it('keeps the allowlist synchronized with shipped skill directories', async () => {
    const skillRoot = resolve(
      import.meta.dirname,
      '../../workflows/skills/standard',
    );
    const directoryNames = (await readdir(skillRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect([...FAST_AGENT_PACKAGED_SKILL_NAMES].sort()).toEqual(directoryNames);
  });

  it('loads every allowlisted packaged skill and exposes Markdown resources', async () => {
    const store = new FastAgentSkillStore();

    for (const name of FAST_AGENT_PACKAGED_SKILL_NAMES) {
      const skill = await store.read(`packaged:${name}`);
      expect(skill).toMatchObject({
        id: `packaged:${name}`,
        name,
        resource: 'SKILL.md',
        source: 'packaged',
      });
      expect(skill.content).toMatch(new RegExp(`name: ["']?${name}["']?`, 'u'));
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.resources).toContain('SKILL.md');
    }

    const reference = await store.read(
      'packaged:security-review',
      'references/authentication.md',
    );
    expect(reference.resource).toBe('references/authentication.md');
    expect(reference.content).toContain('Authentication');
  });

  it('combines packaged and repository-defined skill catalogs', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Prepare the next release.',
            environmentIds: ['environment-1'],
            id: 'repository:repo-1:.agents/skills:changeset-release-pr',
            name: 'changeset-release-pr',
            repository: 'RooCodeInc/Roomote',
            source: 'repository' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(undefined, repositorySkills);

    const catalog = await store.list({ environmentId: 'environment-1' });

    expect(repositorySkills.list).toHaveBeenCalledWith({
      environmentId: 'environment-1',
    });
    expect(catalog.counts).toEqual({
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 1,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 1,
    });
    expect(catalog.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'packaged:security-review',
          source: 'packaged',
        }),
        expect.objectContaining({
          id: 'repository:repo-1:.agents/skills:changeset-release-pr',
          repository: 'RooCodeInc/Roomote',
          source: 'repository',
        }),
      ]),
    );

    repositorySkills.list.mockClear();
    const packagedOnlyCatalog = await store.list();
    expect(repositorySkills.list).not.toHaveBeenCalled();
    expect(packagedOnlyCatalog.counts).toEqual({
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
    });
    expect(packagedOnlyCatalog.skills).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'repository' }),
      ]),
    );
  });

  it('rejects traversal, non-Markdown files, symlinks, and unknown skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fast-skill-store-'));
    const skillDirectory = join(root, 'explore-and-act');
    const referencesDirectory = join(skillDirectory, 'references');
    const outside = join(root, 'outside.md');
    await mkdir(referencesDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), 'safe skill', 'utf8');
    await writeFile(
      join(referencesDirectory, 'guide.md'),
      'safe guide',
      'utf8',
    );
    await writeFile(join(skillDirectory, 'script.ts'), 'unsafe script', 'utf8');
    await writeFile(outside, 'outside content', 'utf8');
    await symlink(outside, join(skillDirectory, 'linked.md'));
    const store = new FastAgentSkillStore(root);

    try {
      await expect(
        store.read('packaged:explore-and-act'),
      ).resolves.toMatchObject({
        content: 'safe skill',
        resources: ['SKILL.md', 'references/guide.md'],
      });
      await expect(
        store.read('packaged:explore-and-act', 'references/guide.md'),
      ).resolves.toMatchObject({ content: 'safe guide' });
      await expect(
        store.read('packaged:explore-and-act', '../outside.md'),
      ).rejects.toThrow('Unknown packaged skill resource.');
      await expect(
        store.read('packaged:explore-and-act', 'script.ts'),
      ).rejects.toThrow('Unknown packaged skill resource.');
      await expect(
        store.read('packaged:explore-and-act', 'linked.md'),
      ).rejects.toThrow('Unknown packaged skill resource.');
      await expect(store.read('packaged:not-a-skill')).rejects.toThrow(
        'Unknown packaged skill.',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
