import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import {
  RemoteFastAgentSettingsSkillSource,
  type FastAgentSettingsPromptCatalog,
} from './fast-agent-settings-skill-source';
import {
  FAST_AGENT_PACKAGED_SKILL_NAMES,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';

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

const PACKAGED_SKILL_NAMES = new Set<string>(FAST_AGENT_PACKAGED_SKILL_NAMES);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadFastAgentPromptSkillCatalog(
  sources: PromptSkillCatalogSources,
): Promise<FastAgentPromptSkillCatalog> {
  const [instance, settings] = await Promise.allSettled([
    sources.instanceSkills.list(),
    sources.settingsSkills.listPromptCatalog(),
  ]);
  // A partial failure degrades to a warning so the surviving source still
  // reaches the prompt. When nothing loaded, throw instead of rendering an
  // empty inventory: the prompt would tell the model no skills are configured
  // and hide every skill behind a transient database error.
  if (instance.status === 'rejected' && settings.status === 'rejected') {
    throw new Error(
      `Instance skills: ${describeError(instance.reason)}; environment skills: ${describeError(settings.reason)}`,
    );
  }
  const instanceSkills =
    instance.status === 'fulfilled' ? instance.value.skills : [];
  const settingsSkills =
    settings.status === 'fulfilled' ? settings.value.skills : [];
  const warnings = [
    ...(instance.status === 'fulfilled'
      ? instance.value.warnings
      : [`Skipped instance skills: ${describeError(instance.reason)}`]),
    ...(settings.status === 'fulfilled'
      ? settings.value.warnings
      : [`Skipped environment skills: ${describeError(settings.reason)}`]),
  ];
  // Same precedence as `list_skills`: a packaged skill shadows every custom
  // skill with its name, and an instance skill shadows an environment skill.
  // The prompt hands the model an exact ID to load directly, so the packaged
  // collision must be filtered here rather than left to the tool.
  const instanceNames = new Set(instanceSkills.map((skill) => skill.name));
  const skills = [
    ...instanceSkills.filter((skill) => !PACKAGED_SKILL_NAMES.has(skill.name)),
    ...settingsSkills.filter(
      (skill) =>
        !PACKAGED_SKILL_NAMES.has(skill.name) && !instanceNames.has(skill.name),
    ),
  ].sort((left, right) =>
    left.name === right.name
      ? left.id.localeCompare(right.id)
      : left.name.localeCompare(right.name),
  );
  return {
    marketplaceSources:
      settings.status === 'fulfilled' ? settings.value.marketplaceSources : [],
    omittedSkillCount: Math.max(
      0,
      skills.length - FAST_AGENT_PROMPT_SKILL_LIMIT,
    ),
    skills: skills.slice(0, FAST_AGENT_PROMPT_SKILL_LIMIT),
    warnings,
  };
}
