import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  FAST_AGENT_PACKAGED_SKILL_NAMES,
  FastAgentSkillStore,
  getDefaultSkillRootCandidates,
  resolveDefaultSkillRoot,
  type FastAgentSkillQuery,
} from '../fast-agent-skill-store';

describe('FastAgentSkillStore', () => {
  it('finds checkout skills from a bundled local-development service directory', async () => {
    const workspaceRoot = resolve(import.meta.dirname, '../../../../../..');
    const bundledEntry = pathToFileURL(
      join(workspaceRoot, 'apps/api/dist/index.js'),
    ).href;
    const serviceDirectory = join(workspaceRoot, 'apps/api');

    await expect(
      resolveDefaultSkillRoot(bundledEntry, serviceDirectory, {
        NODE_ENV: 'development',
      }),
    ).resolves.toBe(
      join(
        workspaceRoot,
        'packages/cloud-agents/src/server/workflows/skills/standard',
      ),
    );
  });

  it('finds checkout skills for Roomote-on-Roomote even with production-like app settings', async () => {
    const workspaceRoot = resolve(import.meta.dirname, '../../../../../..');
    const bundledEntry = pathToFileURL(
      join(workspaceRoot, 'apps/api/dist/index.js'),
    ).href;
    const serviceDirectory = join(workspaceRoot, 'apps/api');

    await expect(
      resolveDefaultSkillRoot(bundledEntry, serviceDirectory, {
        NODE_ENV: 'production',
        ROOMOTE_TASK_ID: 'outer-coding-task',
      }),
    ).resolves.toBe(
      join(
        workspaceRoot,
        'packages/cloud-agents/src/server/workflows/skills/standard',
      ),
    );
  });

  it('keeps the ordinary production candidate order unchanged', () => {
    const candidates = getDefaultSkillRootCandidates(
      pathToFileURL('/roomote/apps/api/dist/index.js').href,
      '/roomote/apps/api',
      {},
    );

    expect(candidates).toEqual([
      '/roomote/apps/api/workflows/skills/standard',
      '/roomote/skills/standard',
    ]);
  });

  it('does not add checkout paths to any production process run from source', () => {
    const workspaceRoot = resolve(import.meta.dirname, '../../../../../..');
    for (const env of [
      { NODE_ENV: 'production' },
      { R_APP_ENV: 'production' },
      { APP_ENV: 'production' },
      { ROOMOTE_APP_ENV: 'production' },
    ]) {
      const candidates = getDefaultSkillRootCandidates(
        pathToFileURL(join(workspaceRoot, 'apps/api/dist/index.js')).href,
        join(workspaceRoot, 'apps/api'),
        env,
      );

      expect(candidates).toEqual([
        join(workspaceRoot, 'apps/api/workflows/skills/standard'),
        join(workspaceRoot, 'skills/standard'),
      ]);
    }
  });

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

  it('lists and loads the partnership skill with its parsed description and paired guide', async () => {
    expect(FAST_AGENT_PACKAGED_SKILL_NAMES).toContain('roomote-partnership');

    const skillRoot = resolve(
      import.meta.dirname,
      '../../workflows/skills/standard',
    );
    const store = new FastAgentSkillStore(skillRoot);
    const catalog = await store.list({ name: 'roomote-partnership' });
    const skill = await store.read('packaged:roomote-partnership');
    const clientGuide = await readFile(
      join(skillRoot, 'roomote-partnership', 'client-guide.md'),
      'utf8',
    );

    expect(catalog).toMatchObject({
      counts: { packaged: 1, total: 1 },
      skills: [
        expect.objectContaining({
          description: expect.stringContaining('joint investigation'),
          id: 'packaged:roomote-partnership',
          name: 'roomote-partnership',
          source: 'packaged',
        }),
      ],
    });
    expect(skill).toMatchObject({
      description: expect.stringContaining('joint investigation'),
      resource: 'SKILL.md',
      resources: expect.arrayContaining(['SKILL.md', 'client-guide.md']),
    });
    expect(skill.content).toContain('name: roomote-partnership');
    expect(clientGuide).toContain('roomote-partnership');
    expect(clientGuide).toContain('If not already loaded');
    expect(clientGuide).not.toContain('before we continue');
    expect(clientGuide).not.toContain('confirm whether it actually loaded');
    for (const content of [skill.content, clientGuide]) {
      expect(content).not.toMatch(/http/iu);
      expect(content).not.toContain('@');
    }
  });

  it('discovers delegation exploration as an unscoped packaged skill', async () => {
    const store = new FastAgentSkillStore();

    await expect(
      store.list({ name: 'explore-delegation' }),
    ).resolves.toMatchObject({
      counts: {
        packaged: 1,
        repository: 0,
        settings: 0,
        total: 1,
      },
      skills: [
        {
          id: 'packaged:explore-delegation',
          invocation: 'explore-delegation',
          name: 'explore-delegation',
          source: 'packaged',
        },
      ],
    });
  });

  it('loads the shipped implement-changes default workflow as a separate resource', async () => {
    const skillRoot = resolve(
      import.meta.dirname,
      '../../workflows/skills/standard',
    );
    const store = new FastAgentSkillStore(skillRoot);
    const resource = 'resources/default-workflow.md';
    const expectedContent = await readFile(
      join(skillRoot, 'implement-changes', resource),
      'utf8',
    );

    const root = await store.read('packaged:implement-changes');
    expect(root.resources).toContain(resource);
    expect(root.content).toContain(resource);
    expect(root.content).not.toContain(expectedContent);

    const workflow = await store.read('packaged:implement-changes', resource);
    expect(expectedContent.trim().length).toBeGreaterThan(0);
    expect(workflow).toMatchObject({
      id: 'packaged:implement-changes',
      invocation: 'implement-changes',
      name: 'implement-changes',
      source: 'packaged',
      resource,
      content: expectedContent,
      byteLength: Buffer.byteLength(expectedContent, 'utf8'),
    });
  });

  it('degrades a failing optional source to a warning', async () => {
    const repositorySkills = {
      list: vi.fn().mockRejectedValue(new Error('Unknown Fast environment.')),
      read: vi.fn(),
    };
    const settingsSkills = {
      list: vi.fn().mockRejectedValue(new Error('Unknown Fast environment.')),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(
      undefined,
      repositorySkills,
      settingsSkills,
    );

    const catalog = await store.list({ environmentId: 'environment-filler' });

    expect(catalog.counts).toEqual({
      instance: 0,
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 0,
      settings: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
    });
    expect(catalog.warnings).toEqual([
      'Skipped legacy Settings skills: Unknown Fast environment.',
      'Skipped repository skills: Unknown Fast environment.',
    ]);
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
      instance: 0,
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 1,
      settings: 0,
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
    expect(repositorySkills.list).toHaveBeenCalledWith(undefined);
    expect(packagedOnlyCatalog.counts).toEqual({
      instance: 0,
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 1,
      settings: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 1,
    });
    expect(packagedOnlyCatalog.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'changeset-release-pr',
          source: 'repository',
        }),
      ]),
    );
    expect(packagedOnlyCatalog.warnings).toEqual([]);
  });

  it('includes authorized repository skills in unscoped inventories with scope metadata', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Use TypeSafe for programmable judgments.',
            environmentIds: ['environment-1', 'environment-2'],
            id: 'repository:repo-1:.agents/skills:typesafe-ai',
            invocation: 'typesafe-ai',
            name: 'typesafe-ai',
            repository: 'RooCodeInc/Roomote',
            source: 'repository' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(undefined, repositorySkills);

    const broadCatalog = await store.list();

    expect(repositorySkills.list).toHaveBeenCalledWith(undefined);
    expect(broadCatalog.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environmentIds: ['environment-1', 'environment-2'],
          id: 'repository:repo-1:.agents/skills:typesafe-ai',
          name: 'typesafe-ai',
          repository: 'RooCodeInc/Roomote',
          source: 'repository',
        }),
      ]),
    );
    expect(broadCatalog.counts).toEqual({
      instance: 0,
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 1,
      settings: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 1,
    });

    repositorySkills.list.mockClear();
    const exactCatalog = await store.list({ name: 'typesafe-ai' });

    expect(repositorySkills.list).toHaveBeenCalledWith(undefined);
    expect(exactCatalog.skills).toEqual([
      expect.objectContaining({
        environmentIds: ['environment-1', 'environment-2'],
        name: 'typesafe-ai',
        repository: 'RooCodeInc/Roomote',
      }),
    ]);
  });

  it('includes authorized settings skills in an unscoped catalog with deterministic precedence', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({ skills: [], warnings: [] }),
      read: vi.fn(),
    };
    const settingsSkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Second environment variant.',
            environmentIds: ['environment-2'],
            id: 'settings:manual:z-thermonuclear',
            name: 'thermonuclear',
            source: 'settings' as const,
          },
          {
            description: 'Must lose to the packaged skill.',
            environmentIds: ['environment-1'],
            id: 'settings:manual:review-code',
            name: 'review-code',
            source: 'settings' as const,
          },
          {
            description: 'First environment variant.',
            environmentIds: ['environment-1'],
            id: 'settings:manual:a-thermonuclear',
            name: 'thermonuclear',
            source: 'settings' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(
      undefined,
      repositorySkills,
      settingsSkills,
    );

    const catalog = await store.list();

    expect(settingsSkills.list).toHaveBeenCalledWith({});
    expect(repositorySkills.list).toHaveBeenCalledWith(undefined);
    expect(
      catalog.skills.filter((skill) => skill.name === 'thermonuclear'),
    ).toEqual([
      expect.objectContaining({
        environmentIds: ['environment-1'],
        id: 'settings:manual:a-thermonuclear',
      }),
      expect.objectContaining({
        environmentIds: ['environment-2'],
        id: 'settings:manual:z-thermonuclear',
      }),
    ]);
    expect(
      catalog.skills.filter((skill) => skill.name === 'review-code'),
    ).toEqual([expect.objectContaining({ id: 'packaged:review-code' })]);
    expect(catalog.counts).toEqual({
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 0,
      settings: 2,
      instance: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 2,
    });
  });

  it('keeps packaged skills ahead of settings skills and settings ahead of repository skills', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Repository collision.',
            id: 'repository:repo-1:.agents/skills:review-code',
            name: 'review-code',
            source: 'repository' as const,
          },
          {
            description: 'Repository release.',
            id: 'repository:repo-1:.agents/skills:release',
            name: 'release',
            source: 'repository' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const settingsSkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Settings collision with packaged.',
            id: 'settings:manual:review-code',
            name: 'review-code',
            source: 'settings' as const,
          },
          {
            description: 'Settings release.',
            id: 'settings:manual:release',
            name: 'release',
            source: 'settings' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(
      undefined,
      repositorySkills,
      settingsSkills,
    );

    const catalog = await store.list({ environmentId: 'environment-1' });

    expect(
      catalog.skills.filter((skill) => skill.name === 'review-code'),
    ).toEqual([expect.objectContaining({ id: 'packaged:review-code' })]);
    expect(catalog.skills.filter((skill) => skill.name === 'release')).toEqual([
      expect.objectContaining({ id: 'settings:manual:release' }),
    ]);
    expect(catalog.counts).toEqual({
      packaged: FAST_AGENT_PACKAGED_SKILL_NAMES.length,
      repository: 0,
      settings: 1,
      instance: 0,
      total: FAST_AGENT_PACKAGED_SKILL_NAMES.length + 1,
    });
  });

  it('keeps Settings precedence across same-name continuation pages', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Repository fallback.',
            id: 'repository:repo-1:.agents/skills:thermonuclear',
            name: 'thermonuclear',
            repository: 'RooCodeInc/Roomote',
            source: 'repository' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const settingsSkills = {
      list: vi
        .fn()
        .mockImplementation(({ sourceOffset }: FastAgentSkillQuery) =>
          Promise.resolve(
            sourceOffset === undefined
              ? {
                  nextSourceOffset: 8,
                  skills: [
                    {
                      description: 'First environment variant.',
                      id: 'settings:manual:thermonuclear-one',
                      name: 'thermonuclear',
                      source: 'settings' as const,
                    },
                  ],
                  warnings: [],
                }
              : {
                  skills: [
                    {
                      description: 'Second environment variant.',
                      id: 'settings:manual:thermonuclear-two',
                      name: 'thermonuclear',
                      source: 'settings' as const,
                    },
                  ],
                  warnings: [],
                },
          ),
        ),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(
      undefined,
      repositorySkills,
      settingsSkills,
    );

    const firstPage = await store.list({ name: 'thermonuclear' });
    const secondPage = await store.list({
      name: 'thermonuclear',
      sourceOffset: 8,
    });

    expect(settingsSkills.list).toHaveBeenNthCalledWith(1, {
      name: 'thermonuclear',
    });
    expect(settingsSkills.list).toHaveBeenNthCalledWith(2, {
      name: 'thermonuclear',
      sourceOffset: 8,
    });
    expect(repositorySkills.list).not.toHaveBeenCalled();
    expect(firstPage.skills).toEqual([
      expect.objectContaining({ id: 'settings:manual:thermonuclear-one' }),
    ]);
    expect(firstPage.nextSourceOffset).toBe(8);
    expect(secondPage.skills).toEqual([
      expect.objectContaining({ id: 'settings:manual:thermonuclear-two' }),
    ]);
    expect(secondPage.nextSourceOffset).toBeUndefined();
  });

  it('checks repositories after paginated Settings lookup is exhausted', async () => {
    const repositorySkills = {
      list: vi.fn().mockResolvedValue({
        skills: [
          {
            description: 'Repository TypeSafe guidance.',
            environmentIds: ['environment-1'],
            id: 'repository:repo-1:.agents/skills:typesafe-ai',
            name: 'typesafe-ai',
            repository: 'RooCodeInc/Roomote',
            source: 'repository' as const,
          },
        ],
        warnings: [],
      }),
      read: vi.fn(),
    };
    const settingsSkills = {
      list: vi
        .fn()
        .mockImplementation(({ sourceOffset }: FastAgentSkillQuery) =>
          Promise.resolve(
            sourceOffset === undefined
              ? {
                  nextSourceOffset: 8,
                  skills: [],
                  warnings: [],
                }
              : { skills: [], warnings: [] },
          ),
        ),
      read: vi.fn(),
    };
    const store = new FastAgentSkillStore(
      undefined,
      repositorySkills,
      settingsSkills,
    );

    const firstPage = await store.list({ name: 'typesafe-ai' });
    expect(firstPage.nextSourceOffset).toBe(8);
    expect(repositorySkills.list).not.toHaveBeenCalled();

    const finalPage = await store.list({
      name: 'typesafe-ai',
      sourceOffset: 8,
    });
    expect(repositorySkills.list).toHaveBeenCalledWith(undefined);
    expect(finalPage.skills).toEqual([
      expect.objectContaining({
        name: 'typesafe-ai',
        repository: 'RooCodeInc/Roomote',
      }),
    ]);
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
