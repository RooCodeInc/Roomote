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

import { FastAgentSkillStore } from '../fast-agent-skill-store';
import {
  FAST_DIRECT_PACKAGED_SKILL_NAMES,
  FAST_TASK_PACKAGED_SKILL_NAMES,
  PACKAGED_SKILL_CATALOG,
} from '../../../packaged-skill-catalog';

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

    expect(Object.keys(PACKAGED_SKILL_CATALOG).sort()).toEqual(directoryNames);
    expect(FAST_DIRECT_PACKAGED_SKILL_NAMES).toEqual(['explore-and-act']);
    expect(FAST_TASK_PACKAGED_SKILL_NAMES).toContain('implement-changes');
  });

  it('loads every allowlisted packaged skill and exposes Markdown resources', async () => {
    const store = new FastAgentSkillStore();

    for (const name of FAST_DIRECT_PACKAGED_SKILL_NAMES) {
      const skill = await store.read(name);
      expect(skill).toMatchObject({ name, resource: 'SKILL.md' });
      expect(skill.content).toMatch(new RegExp(`name: ["']?${name}["']?`, 'u'));
      expect(skill.resources).toContain('SKILL.md');
    }

    await expect(store.read('security-review')).rejects.toThrow(
      'Unknown packaged skill.',
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
      await expect(store.read('explore-and-act')).resolves.toMatchObject({
        content: 'safe skill',
        resources: ['SKILL.md', 'references/guide.md'],
      });
      await expect(
        store.read('explore-and-act', 'references/guide.md'),
      ).resolves.toMatchObject({ content: 'safe guide' });
      await expect(
        store.read('explore-and-act', '../outside.md'),
      ).rejects.toThrow('Unknown packaged skill resource.');
      await expect(store.read('explore-and-act', 'script.ts')).rejects.toThrow(
        'Unknown packaged skill resource.',
      );
      await expect(store.read('explore-and-act', 'linked.md')).rejects.toThrow(
        'Unknown packaged skill resource.',
      );
      await expect(store.read('not-a-skill')).rejects.toThrow(
        'Unknown packaged skill.',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
