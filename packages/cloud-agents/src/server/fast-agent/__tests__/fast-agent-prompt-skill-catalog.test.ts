import {
  FAST_AGENT_PROMPT_SKILL_LIMIT,
  loadFastAgentPromptSkillCatalog,
} from '../fast-agent-prompt-skill-catalog';
import type { FastAgentSkillSummary } from '../fast-agent-skill-store';

function instanceSkill(name: string): FastAgentSkillSummary {
  return {
    description: `Use for ${name}.`,
    id: `instance:${name}`,
    invocation: name,
    name,
    source: 'instance',
    version: 1,
  };
}

function settingsSkill(
  name: string,
  environmentIds = ['environment-1'],
): FastAgentSkillSummary {
  return {
    description: `Environment guidance for ${name}.`,
    environmentIds,
    id: `settings:manual:${name}`,
    invocation: name,
    name,
    source: 'settings',
  };
}

describe('loadFastAgentPromptSkillCatalog', () => {
  it('merges instance and inline environment skills with instance precedence', async () => {
    const catalog = await loadFastAgentPromptSkillCatalog({
      instanceSkills: {
        list: vi.fn().mockResolvedValue({
          skills: [instanceSkill('release-checklist')],
          warnings: [],
        }),
      },
      settingsSkills: {
        listPromptCatalog: vi.fn().mockResolvedValue({
          marketplaceSources: [
            { environmentId: 'environment-1', sources: ['anthropics/skills'] },
          ],
          skills: [
            settingsSkill('release-checklist'),
            settingsSkill('support-triage'),
          ],
          warnings: ['one environment skill was too large'],
        }),
      },
    });

    expect(catalog.skills.map((skill) => skill.id)).toEqual([
      'instance:release-checklist',
      'settings:manual:support-triage',
    ]);
    expect(catalog.marketplaceSources).toEqual([
      { environmentId: 'environment-1', sources: ['anthropics/skills'] },
    ]);
    expect(catalog.omittedSkillCount).toBe(0);
    expect(catalog.warnings).toEqual(['one environment skill was too large']);
  });

  it('drops custom skills that collide with a packaged skill name', async () => {
    const catalog = await loadFastAgentPromptSkillCatalog({
      instanceSkills: {
        list: vi.fn().mockResolvedValue({
          skills: [instanceSkill('review-code'), instanceSkill('daily-brief')],
          warnings: [],
        }),
      },
      settingsSkills: {
        listPromptCatalog: vi.fn().mockResolvedValue({
          marketplaceSources: [],
          skills: [settingsSkill('create-pr'), settingsSkill('support-triage')],
          warnings: [],
        }),
      },
    });

    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      'daily-brief',
      'support-triage',
    ]);
  });

  it('throws when every source fails so the prompt shows the recovery state', async () => {
    await expect(
      loadFastAgentPromptSkillCatalog({
        instanceSkills: {
          list: vi.fn().mockRejectedValue(new Error('Not a member.')),
        },
        settingsSkills: {
          listPromptCatalog: vi
            .fn()
            .mockRejectedValue(new Error('database unavailable')),
        },
      }),
    ).rejects.toThrow(
      'Instance skills: Not a member.; environment skills: database unavailable',
    );
  });

  it('degrades each source independently instead of failing the prompt', async () => {
    const catalog = await loadFastAgentPromptSkillCatalog({
      instanceSkills: {
        list: vi.fn().mockRejectedValue(new Error('Not a member.')),
      },
      settingsSkills: {
        listPromptCatalog: vi.fn().mockResolvedValue({
          marketplaceSources: [],
          skills: [settingsSkill('support-triage')],
          warnings: [],
        }),
      },
    });

    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      'support-triage',
    ]);
    expect(catalog.warnings).toEqual([
      'Skipped instance skills: Not a member.',
    ]);
  });

  it('caps the prompt list and reports how many skills were omitted', async () => {
    const catalog = await loadFastAgentPromptSkillCatalog({
      instanceSkills: {
        list: vi.fn().mockResolvedValue({
          skills: Array.from(
            { length: FAST_AGENT_PROMPT_SKILL_LIMIT + 3 },
            (_, index) =>
              instanceSkill(`skill-${String(index).padStart(3, '0')}`),
          ),
          warnings: [],
        }),
      },
      settingsSkills: {
        listPromptCatalog: vi.fn().mockResolvedValue({
          marketplaceSources: [],
          skills: [],
          warnings: [],
        }),
      },
    });

    expect(catalog.skills).toHaveLength(FAST_AGENT_PROMPT_SKILL_LIMIT);
    expect(catalog.omittedSkillCount).toBe(3);
  });
});
