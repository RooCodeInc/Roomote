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
      const skill = await store.read(name);
      expect(skill).toMatchObject({ name, resource: 'SKILL.md' });
      expect(skill.content).toMatch(new RegExp(`name: ["']?${name}["']?`, 'u'));
      expect(skill.resources).toContain('SKILL.md');
    }

    const reference = await store.read(
      'security-review',
      'references/authentication.md',
    );
    expect(reference.resource).toBe('references/authentication.md');
    expect(reference.content).toContain('Authentication');
  });

  it('rejects traversal, non-Markdown files, symlinks, and unknown skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fast-skill-store-'));
    const skillDirectory = join(root, 'security-review');
    const outside = join(root, 'outside.md');
    await mkdir(skillDirectory);
    await writeFile(join(skillDirectory, 'SKILL.md'), 'safe skill', 'utf8');
    await writeFile(join(skillDirectory, 'script.ts'), 'unsafe script', 'utf8');
    await writeFile(outside, 'outside content', 'utf8');
    await symlink(outside, join(skillDirectory, 'linked.md'));
    const store = new FastAgentSkillStore(root);

    try {
      await expect(store.read('security-review')).resolves.toMatchObject({
        content: 'safe skill',
        resources: ['SKILL.md'],
      });
      await expect(
        store.read('security-review', '../outside.md'),
      ).rejects.toThrow('Unknown packaged skill resource.');
      await expect(store.read('security-review', 'script.ts')).rejects.toThrow(
        'Unknown packaged skill resource.',
      );
      await expect(store.read('security-review', 'linked.md')).rejects.toThrow(
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
