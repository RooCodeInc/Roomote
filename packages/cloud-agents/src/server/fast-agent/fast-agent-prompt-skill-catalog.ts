import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import {
  RemoteFastAgentSettingsSkillSource,
  type FastAgentSettingsPromptCatalog,
} from './fast-agent-settings-skill-source';
import {
  FAST_AGENT_PACKAGED_SKILL_NAMES,
  type FastAgentSkillListResult,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';

/** Skills listed inline in the Fast system prompt so the model can recognize
 * a relevant playbook without first guessing that `list_skills` is worth a
 * call. The underlying sources remain bounded and authorized to the current
 * turn, so repository and marketplace skills can be shown with their scope
 * instead of requiring the model to guess one before discovery. */
export type FastAgentPromptSkillCatalog = {
  marketplaceSources: FastAgentSettingsPromptCatalog['marketplaceSources'];
  /** Skills omitted from the prompt after `FAST_AGENT_PROMPT_SKILL_LIMIT`. */
  omittedSkillCount: number;
  /** The omitted skills themselves, in catalog order. They stay out of the
   * system prompt; the per-turn skill relevance hint can still name one. */
  omittedSkills?: FastAgentSkillSummary[];
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

export const FAST_AGENT_PROMPT_SKILL_LIMIT = 64;
const PROMPT_SKILL_CATALOG_CACHE_TTL_MS = 30_000;

type PromptSkillCatalogSources = {
  instanceSkills: Pick<RemoteFastAgentInstanceSkillSource, 'list'>;
  settingsSkills: Pick<
    RemoteFastAgentSettingsSkillSource,
    'listPromptCatalog'
  > & {
    dispose?: () => Promise<void>;
  };
  repositorySkills?: Pick<RemoteFastAgentRepositorySkillSource, 'list'> & {
    dispose?: () => Promise<void>;
  };
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
    repositorySkills: new RemoteFastAgentRepositorySkillSource({
      allowedEnvironmentIds,
    }),
  };
}

const PACKAGED_SKILL_NAMES = new Set<string>(FAST_AGENT_PACKAGED_SKILL_NAMES);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settlePromptSkillSource<T>(
  load: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([Promise.resolve().then(load)]);
  return result!;
}

export async function loadFastAgentPromptSkillCatalog(
  sources: PromptSkillCatalogSources,
  options: { repositoryCacheKey?: string } = {},
): Promise<FastAgentPromptSkillCatalog> {
  const repository = sources.repositorySkills
    ? loadRepositorySkillSource(
        sources.repositorySkills,
        options.repositoryCacheKey,
      )
    : Promise.resolve<
        PromiseSettledResult<FastAgentSkillListResult> | undefined
      >(undefined);
  const [instance, settings, repositoryResult] = await Promise.all([
    settlePromptSkillSource(() => sources.instanceSkills.list()),
    settlePromptSkillSource(() => sources.settingsSkills.listPromptCatalog()),
    repository,
  ]);

  return mergeFastAgentPromptSkillCatalog(
    instance,
    settings,
    repositoryResult,
    sources,
  );
}

const repositorySkillSourceCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<PromiseSettledResult<FastAgentSkillListResult>>;
  }
>();

async function loadRepositorySkillSource(
  source: NonNullable<PromptSkillCatalogSources['repositorySkills']>,
  cacheKey?: string,
): Promise<PromiseSettledResult<FastAgentSkillListResult>> {
  const now = Date.now();
  for (const [key, entry] of repositorySkillSourceCache) {
    if (entry.expiresAt <= now) repositorySkillSourceCache.delete(key);
  }
  if (!cacheKey) return settlePromptSkillSource(() => source.list());
  const cached = repositorySkillSourceCache.get(cacheKey);
  if (cached) return cached.promise;

  const promise = settlePromptSkillSource(() => source.list());
  repositorySkillSourceCache.set(cacheKey, {
    expiresAt: Date.now() + PROMPT_SKILL_CATALOG_CACHE_TTL_MS,
    promise,
  });
  promise.then((result) => {
    if (result.status === 'rejected') {
      const current = repositorySkillSourceCache.get(cacheKey);
      if (current?.promise === promise)
        repositorySkillSourceCache.delete(cacheKey);
    }
  });
  return promise;
}

async function mergeFastAgentPromptSkillCatalog(
  instance: PromiseSettledResult<FastAgentSkillListResult>,
  settings: PromiseSettledResult<FastAgentSettingsPromptCatalog>,
  repository: PromiseSettledResult<FastAgentSkillListResult> | undefined,
  sources: PromptSkillCatalogSources,
): Promise<FastAgentPromptSkillCatalog> {
  try {
    // A partial failure degrades to a warning so the surviving source still
    // reaches the prompt. When nothing loaded, throw instead of rendering an
    // empty inventory: the prompt would tell the model no skills are configured
    // and hide every skill behind a transient database or Git error.
    if (
      instance.status === 'rejected' &&
      settings.status === 'rejected' &&
      (!repository || repository.status === 'rejected')
    ) {
      const repositoryError = repository
        ? `; repository skills: ${describeError(repository.reason)}`
        : '';
      throw new Error(
        `Instance skills: ${describeError(instance.reason)}; environment skills: ${describeError(settings.reason)}${repositoryError}`,
      );
    }
    const instanceSkills =
      instance.status === 'fulfilled' ? instance.value.skills : [];
    const settingsSkills =
      settings.status === 'fulfilled' ? settings.value.skills : [];
    const repositorySkills =
      repository?.status === 'fulfilled' ? repository.value.skills : [];
    const warnings = [
      ...(instance.status === 'fulfilled'
        ? instance.value.warnings
        : [`Skipped instance skills: ${describeError(instance.reason)}`]),
      ...(settings.status === 'fulfilled'
        ? settings.value.warnings
        : [`Skipped environment skills: ${describeError(settings.reason)}`]),
      ...(repository
        ? repository.status === 'fulfilled'
          ? repository.value.warnings
          : [`Skipped repository skills: ${describeError(repository.reason)}`]
        : []),
    ];
    // Same precedence as `list_skills`: a packaged skill shadows every custom
    // skill with its name, and an instance skill shadows environment and
    // repository skills. The prompt hands the model exact IDs to load
    // directly, so collisions must be filtered here rather than left to the
    // tool.
    const visibleInstanceSkills = instanceSkills.filter(
      (skill) => !PACKAGED_SKILL_NAMES.has(skill.name),
    );
    const instanceNames = new Set(
      visibleInstanceSkills.map((skill) => skill.name),
    );
    const visibleSettingsSkills = settingsSkills.filter(
      (skill) =>
        !PACKAGED_SKILL_NAMES.has(skill.name) && !instanceNames.has(skill.name),
    );
    const settingsNames = new Set(
      visibleSettingsSkills.map((skill) => skill.name),
    );
    const skills = [
      ...visibleInstanceSkills,
      ...visibleSettingsSkills,
      ...repositorySkills.filter(
        (skill) =>
          !PACKAGED_SKILL_NAMES.has(skill.name) &&
          !instanceNames.has(skill.name) &&
          !settingsNames.has(skill.name),
      ),
    ].sort((left, right) =>
      left.name === right.name
        ? left.id.localeCompare(right.id)
        : left.name.localeCompare(right.name),
    );
    return {
      marketplaceSources:
        settings.status === 'fulfilled'
          ? settings.value.marketplaceSources
          : [],
      omittedSkillCount: Math.max(
        0,
        skills.length - FAST_AGENT_PROMPT_SKILL_LIMIT,
      ),
      omittedSkills: skills.slice(FAST_AGENT_PROMPT_SKILL_LIMIT),
      skills: skills.slice(0, FAST_AGENT_PROMPT_SKILL_LIMIT),
      warnings,
    };
  } finally {
    const disposals = [
      sources.settingsSkills.dispose?.(),
      sources.repositorySkills?.dispose?.(),
    ].filter((promise): promise is Promise<void> => Boolean(promise));
    await Promise.allSettled(disposals);
  }
}
