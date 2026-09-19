import { describe, expect, it } from 'vitest';

import {
  formatUserCallableSkillsPage,
  listUserCallableFastAgentSkills,
  parseSkillsCommandPage,
} from '../fast-agent-skill-command';

describe('Fast skill command', () => {
  it('merges scoped catalogs using canonical precedence', async () => {
    const catalog = await listUserCallableFastAgentSkills('user-1', {
      environmentIds: ['env-1'],
      list: async (environmentId) => ({
        skills: environmentId
          ? [
              {
                id: 'repository:one',
                name: 'review',
                invocation: 'review',
                description: 'Repository review',
                source: 'repository',
              },
              {
                id: 'repository:deploy',
                name: 'deploy',
                invocation: 'deploy',
                description: 'Deploy this repository',
                source: 'repository',
              },
            ]
          : [
              {
                id: 'packaged:review',
                name: 'review',
                invocation: 'review',
                description: 'Packaged review',
                source: 'packaged',
              },
            ],
        warnings: environmentId ? ['repository warning'] : [],
      }),
    });

    expect(catalog.skills).toEqual([
      expect.objectContaining({ invocation: 'deploy', source: 'repository' }),
      expect.objectContaining({ invocation: 'review', source: 'packaged' }),
    ]);
    expect(catalog.warnings).toEqual(['repository warning']);
  });

  it('paginates without silently dropping remaining skills', () => {
    const text = formatUserCallableSkillsPage({
      catalog: {
        skills: Array.from({ length: 11 }, (_, index) => ({
          id: `packaged:skill-${index}`,
          name: `skill-${index}`,
          invocation: `skill-${index}`,
          description: 'A useful skill',
          source: 'packaged' as const,
        })),
        warnings: ['one source failed'],
      },
      page: 1,
      command: '/skills',
    });

    expect(text).toContain('page 1/2');
    expect(text).toContain('Next page: `/skills 2`.');
    expect(text).toContain('could not be fully inspected');
    expect(text).not.toContain('$skill-10` —');
  });

  it('recognizes bounded skills command syntax', () => {
    expect(parseSkillsCommandPage('/skills')).toBe(1);
    expect(parseSkillsCommandPage('skills 3')).toBe(3);
    expect(parseSkillsCommandPage('/skills all')).toBeNull();
    expect(parseSkillsCommandPage('show skills')).toBeNull();
  });
});
