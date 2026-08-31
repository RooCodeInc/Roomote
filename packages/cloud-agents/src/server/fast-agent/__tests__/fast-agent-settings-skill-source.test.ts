import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { environmentConfigSchema } from '@roomote/types';

import {
  RemoteFastAgentSettingsSkillSource,
  loadFastAgentSettingsMarketplaceSnapshot,
  type SettingsSkillMarketplaceSnapshot,
} from '../fast-agent-settings-skill-source';

function environmentConfig(overrides: Record<string, unknown>) {
  return environmentConfigSchema.parse({
    name: 'Fast skills test',
    repositories: [{ repository: 'RooCodeInc/Roomote' }],
    ...overrides,
  });
}

function marketplaceSnapshot({
  name = 'marketplace-review',
  source = 'example/skills',
}: {
  name?: string;
  source?: string;
} = {}): SettingsSkillMarketplaceSnapshot {
  const content = [
    '---',
    `name: ${name}`,
    'description: Review with the marketplace playbook.',
    '---',
    '',
    '# Marketplace review',
  ].join('\n');
  return {
    directory: '/tmp/unused-settings-skill-repository.git',
    records: [
      {
        content,
        description: 'Review with the marketplace playbook.',
        name,
        resources: new Map([
          [
            'SKILL.md',
            {
              byteLength: Buffer.byteLength(content),
              path: `skills/${name}/SKILL.md`,
              resource: 'SKILL.md',
            },
          ],
        ]),
        sourceName: source,
      },
    ],
    revision: 'abc123',
    source,
  };
}

describe('RemoteFastAgentSettingsSkillSource', () => {
  it('lists and loads only manual skills from authorized environments', async () => {
    const source = new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: ['environment-1'],
      resolveEnvironments: vi.fn().mockResolvedValue([
        {
          id: 'environment-1',
          config: environmentConfig({
            manualSkills: [
              {
                name: 'support-triage',
                description: 'Triage support reports.',
                content: '# Support triage\n\nInspect the report.',
              },
            ],
          }),
        },
        {
          id: 'inaccessible-environment',
          config: environmentConfig({
            manualSkills: [
              {
                name: 'private-playbook',
                description: 'Must not be visible.',
                content: '# Private',
              },
            ],
          }),
        },
      ]),
    });

    const catalog = await source.list({ name: 'support-triage' });

    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toMatchObject({
      environmentIds: ['environment-1'],
      invocation: 'support-triage',
      name: 'support-triage',
      source: 'settings',
    });
    expect(catalog.skills[0]?.id).toMatch(/^settings:manual:[a-f0-9]{64}$/u);
    await expect(source.read(catalog.skills[0]!.id)).resolves.toMatchObject({
      content: expect.stringContaining('# Support triage'),
      environmentIds: ['environment-1'],
      source: 'settings',
    });
    await expect(
      source.list({ environmentId: 'inaccessible-environment' }),
    ).rejects.toThrow('Unknown Fast environment.');
  });

  it('applies marketplace selections per environment and uses revision-stable IDs', async () => {
    const loadMarketplaceSnapshot = vi
      .fn()
      .mockResolvedValue(marketplaceSnapshot());
    const source = new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: ['environment-1', 'environment-2'],
      loadMarketplaceSnapshot,
      resolveEnvironments: vi.fn().mockResolvedValue([
        {
          id: 'environment-1',
          config: environmentConfig({
            skills: { 'example/skills': ['marketplace-review'] },
          }),
        },
        {
          id: 'environment-2',
          config: environmentConfig({
            skills: { 'example/skills': 'all' },
          }),
        },
      ]),
    });

    const catalog = await source.list({ name: 'marketplace-review' });

    expect(loadMarketplaceSnapshot).toHaveBeenCalledOnce();
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        environmentIds: ['environment-1', 'environment-2'],
        invocation: 'marketplace-review',
        settingsSource: 'example/skills',
        source: 'settings',
      }),
    ]);
    expect(catalog.skills[0]?.id).toMatch(
      /^settings:marketplace:[a-f0-9]{64}$/u,
    );
    await expect(source.read(catalog.skills[0]!.id)).resolves.toMatchObject({
      content: expect.stringContaining('# Marketplace review'),
      settingsSource: 'example/skills',
    });
  });

  it('filters exact-name sources before applying the marketplace source cap', async () => {
    const skills = Object.fromEntries([
      ...Array.from({ length: 8 }, (_, index) => [
        `owner/source-${index + 1}`,
        [`other-skill-${index + 1}`],
      ]),
      ['owner/source-9', ['target-skill']],
    ]);
    const loadMarketplaceSnapshot = vi
      .fn()
      .mockImplementation(async (source: string) =>
        marketplaceSnapshot({ name: 'target-skill', source }),
      );
    const source = new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: ['environment-1'],
      loadMarketplaceSnapshot,
      resolveEnvironments: vi.fn().mockResolvedValue([
        {
          id: 'environment-1',
          config: environmentConfig({ skills }),
        },
      ]),
    });

    const catalog = await source.list({ name: 'target-skill' });

    expect(loadMarketplaceSnapshot).toHaveBeenCalledOnce();
    expect(loadMarketplaceSnapshot).toHaveBeenCalledWith('owner/source-9');
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        name: 'target-skill',
        settingsSource: 'owner/source-9',
      }),
    ]);
    expect(catalog.warnings).toEqual([]);
  });

  it('searches all authorized all-selection sources for an exact name in bounded batches', async () => {
    const skills = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `owner/source-${index + 1}`,
        'all',
      ]),
    );
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const loadMarketplaceSnapshot = vi
      .fn()
      .mockImplementation(async (source: string) => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        await Promise.resolve();
        activeLoads -= 1;
        return marketplaceSnapshot({
          name: source === 'owner/source-9' ? 'target-skill' : 'other-skill',
          source,
        });
      });
    const source = new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: ['environment-1'],
      loadMarketplaceSnapshot,
      resolveEnvironments: vi.fn().mockResolvedValue([
        {
          id: 'environment-1',
          config: environmentConfig({ skills }),
        },
      ]),
    });

    const catalog = await source.list({ name: 'target-skill' });

    expect(loadMarketplaceSnapshot).toHaveBeenCalledTimes(9);
    expect(maxActiveLoads).toBeLessThanOrEqual(8);
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        name: 'target-skill',
        settingsSource: 'owner/source-9',
      }),
    ]);
    expect(catalog.warnings).toEqual([]);
  });

  it('uses targeted sized tree metadata to exclude oversized Markdown resources', async () => {
    const objectId = 'a'.repeat(40);
    const metadataTree = [
      `100644 blob ${objectId}\tskills/example/SKILL.md`,
      `100644 blob ${objectId}\tskills/example/guide.md`,
      `100644 blob ${objectId}\tskills/example/oversized.md`,
      '',
    ].join('\0');
    const sizedTree = [
      `100644 blob ${objectId} 120\tskills/example/SKILL.md`,
      `100644 blob ${objectId} 80\tskills/example/guide.md`,
      `100644 blob ${objectId} ${8 * 1024 * 1024 + 1}\tskills/example/oversized.md`,
      '',
    ].join('\0');
    const content = [
      '---',
      'name: example',
      'description: Example skill.',
      '---',
      '',
      '# Example',
    ].join('\n');
    const executeGit = vi.fn(async (args: string[]) => {
      if (args.includes('rev-parse')) return 'abc123\n';
      if (args.includes('ls-tree') && args.includes('-l')) return sizedTree;
      if (args.includes('ls-tree')) return metadataTree;
      if (args.includes('show')) return content;
      return '';
    });

    const snapshot = await loadFastAgentSettingsMarketplaceSnapshot(
      'owner/source',
      executeGit,
    );
    try {
      expect(executeGit).toHaveBeenCalledWith(
        expect.arrayContaining([
          'ls-tree',
          '-l',
          '--',
          'skills/example/SKILL.md',
          'skills/example/guide.md',
          'skills/example/oversized.md',
        ]),
      );
      expect([...snapshot.records[0]!.resources.keys()].sort()).toEqual([
        'SKILL.md',
        'guide.md',
      ]);
    } finally {
      await rm(dirname(snapshot.directory), { recursive: true, force: true });
    }
  });

  it('returns no settings skills when a repository has no active authorized environment mapping', async () => {
    const resolveEnvironments = vi.fn().mockResolvedValue([]);
    const loadMarketplaceSnapshot = vi.fn();
    const source = new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: ['environment-1'],
      loadMarketplaceSnapshot,
      resolveEnvironments,
    });

    const catalog = await source.list({ repositoryId: 'inactive-repository' });

    expect(resolveEnvironments).toHaveBeenCalledWith({
      repositoryId: 'inactive-repository',
    });
    expect(catalog.skills).toEqual([]);
    expect(loadMarketplaceSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsafe marketplace source names before fetching', async () => {
    await expect(
      loadFastAgentSettingsMarketplaceSnapshot('../private'),
    ).rejects.toThrow('Unsupported settings skill source.');
    await expect(
      loadFastAgentSettingsMarketplaceSnapshot('owner/..'),
    ).rejects.toThrow('Unsupported settings skill source.');
  });
});
