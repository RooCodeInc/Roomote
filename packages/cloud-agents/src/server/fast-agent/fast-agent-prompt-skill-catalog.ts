import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import {
  RemoteFastAgentSettingsSkillSource,
  type FastAgentSettingsPromptCatalog,
} from './fast-agent-settings-skill-source';
import type { FastAgentSkillSummary } from './fast-agent-skill-store';

/** Skills listed inline in the Fast system prompt so the model can recognize
 * a relevant playbook without first guessing that `list_skills` is worth a
 * call. Only sources that cost a database read are included: instance skills
 * and inline environment (`manualSkills`) skills. Marketplace and repository
 * skills need a git fetch, so the prompt names their sources and the model
 * enumerates them on demand. */
export type FastAgentPromptSkillCatalog = {
  marketplaceSources: FastAgentSettingsPromptCatalog['marketplaceSources'];
  /** Skills omitted from the prompt after `FAST_AGENT_PROMPT_SKILL_LIMIT`. */
  omittedSkillCount: number;
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

export const FAST_AGENT_PROMPT_SKILL_LIMIT = 64;

type PromptSkillCatalogSources = {
  instanceSkills: Pick<RemoteFastAgentInstanceSkillSource, 'list'>;
  settingsSkills: Pick<RemoteFastAgentSettingsSkillSource, 'listPromptCatalog'>;
};

export function createFastAgentPromptSkillCatalogSources({
  allowedEnvironmentIds,
  userId,
}: {
  allowedEnvironmentIds: string[];
  userId: string;
}): PromptSkillCatalogSources {
  return {
    instanceSkills: new RemoteFastAgentInstanceSkillSource(userId),
    settingsSkills: new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds,
    }),
  };
}

export async function loadFastAgentPromptSkillCatalog(
  sources: PromptSkillCatalogSources,
): Promise<FastAgentPromptSkillCatalog> {
  const [instance, settings] = await Promise.all([
    sources.instanceSkills.list().catch((error: unknown) => ({
      skills: [] as FastAgentSkillSummary[],
      warnings: [
        `Skipped instance skills: ${error instanceof Error ? error.message : String(error)}`,
      ],
    })),
    sources.settingsSkills.listPromptCatalog().catch((error: unknown) => ({
      marketplaceSources: [],
      skills: [] as FastAgentSkillSummary[],
      warnings: [
        `Skipped environment skills: ${error instanceof Error ? error.message : String(error)}`,
      ],
    })),
  ]);
  // Same precedence as `list_skills`: an instance skill shadows an environment
  // skill with the same name. Packaged names are not filtered here because the
  // prompt never lists packaged skills, and `list_skills` applies that rule.
  const instanceNames = new Set(instance.skills.map((skill) => skill.name));
  const skills = [
    ...instance.skills,
    ...settings.skills.filter((skill) => !instanceNames.has(skill.name)),
  ].sort((left, right) =>
    left.name === right.name
      ? left.id.localeCompare(right.id)
      : left.name.localeCompare(right.name),
  );
  return {
    marketplaceSources: settings.marketplaceSources,
    omittedSkillCount: Math.max(
      0,
      skills.length - FAST_AGENT_PROMPT_SKILL_LIMIT,
    ),
    skills: skills.slice(0, FAST_AGENT_PROMPT_SKILL_LIMIT),
    warnings: [...instance.warnings, ...settings.warnings],
  };
}
