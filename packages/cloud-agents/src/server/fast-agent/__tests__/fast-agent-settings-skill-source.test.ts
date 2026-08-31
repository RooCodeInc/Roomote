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

function marketplaceSnapshot(): SettingsSkillMarketplaceSnapshot {
  const content = [
    '---',
    'name: marketplace-review',
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
        name: 'marketplace-review',
        resources: new Map([
          [
            'SKILL.md',
            {
              byteLength: Buffer.byteLength(content),
              path: 'skills/marketplace-review/SKILL.md',
              resource: 'SKILL.md',
            },
          ],
        ]),
        sourceName: 'example/skills',
      },
    ],
    revision: 'abc123',
    source: 'example/skills',
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
