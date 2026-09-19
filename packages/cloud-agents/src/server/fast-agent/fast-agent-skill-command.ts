import { getAvailableEnvironments } from '../available-environments';
import { RemoteFastAgentInstanceSkillSource } from './fast-agent-instance-skill-source';
import { RemoteFastAgentRepositorySkillSource } from './fast-agent-repository-skill-source';
import { RemoteFastAgentSettingsSkillSource } from './fast-agent-settings-skill-source';
import {
  FastAgentSkillStore,
  type FastAgentSkillListResult,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';

const SKILLS_PER_PAGE = 8;
const SKILL_DESCRIPTION_MAX_LENGTH = 120;
const SOURCE_PRECEDENCE = {
  packaged: 0,
  instance: 1,
  settings: 2,
  repository: 3,
} as const;

export type UserCallableSkillCatalog = {
  skills: FastAgentSkillSummary[];
  warnings: string[];
};

type SkillCatalogDependencies = {
  environmentIds?: string[];
  list?: (environmentId?: string) => Promise<FastAgentSkillListResult>;
};

function mergeSkillCatalogs(
  catalogs: FastAgentSkillListResult[],
): UserCallableSkillCatalog {
  const skillsById = new Map<string, FastAgentSkillSummary>();
  const warnings = new Set<string>();
  for (const catalog of catalogs) {
    for (const skill of catalog.skills) skillsById.set(skill.id, skill);
    for (const warning of catalog.warnings) warnings.add(warning);
  }

  const precedenceByInvocation = new Map<string, number>();
  for (const skill of skillsById.values()) {
    const invocation = skill.invocation ?? skill.name;
    const precedence = SOURCE_PRECEDENCE[skill.source];
    const current = precedenceByInvocation.get(invocation);
    if (current === undefined || precedence < current) {
      precedenceByInvocation.set(invocation, precedence);
    }
  }

  return {
    skills: [...skillsById.values()]
      .filter(
        (skill) =>
          SOURCE_PRECEDENCE[skill.source] ===
          precedenceByInvocation.get(skill.invocation ?? skill.name),
      )
      .sort((left, right) => {
        const invocationDifference = (
          left.invocation ?? left.name
        ).localeCompare(right.invocation ?? right.name);
        return invocationDifference || left.id.localeCompare(right.id);
      }),
    warnings: [...warnings],
  };
}

export async function listUserCallableFastAgentSkills(
  userId: string,
  dependencies: SkillCatalogDependencies = {},
): Promise<UserCallableSkillCatalog> {
  const environmentIds =
    dependencies.environmentIds ??
    (await getAvailableEnvironments()).map((environment) => environment.id);
  if (dependencies.list) {
    return mergeSkillCatalogs(
      await Promise.all([
        dependencies.list(),
        ...environmentIds.map((environmentId) =>
          dependencies.list!(environmentId),
        ),
      ]),
    );
  }

  const skillStore = new FastAgentSkillStore(
    undefined,
    new RemoteFastAgentRepositorySkillSource({
      allowedEnvironmentIds: environmentIds,
    }),
    new RemoteFastAgentSettingsSkillSource({
      allowedEnvironmentIds: environmentIds,
    }),
    new RemoteFastAgentInstanceSkillSource(userId),
  );
  try {
    return mergeSkillCatalogs(
      await Promise.all([
        skillStore.list(),
        ...environmentIds.map((environmentId) =>
          skillStore.list({ environmentId }),
        ),
      ]),
    );
  } finally {
    await skillStore.dispose();
  }
}

function conciseDescription(description: string): string {
  const normalized = description.replace(/\s+/gu, ' ').trim();
  if (!normalized) return 'No description provided.';
  return normalized.length <= SKILL_DESCRIPTION_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, SKILL_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatSkillDescription(skill: FastAgentSkillSummary): string {
  return `${conciseDescription(skill.description)}${skill.repository ? ` (${skill.repository})` : ''}`;
}

export function formatUserCallableSkillsPage(input: {
  catalog: UserCallableSkillCatalog;
  page?: number;
  command: string;
}): string {
  const pageCount = Math.max(
    1,
    Math.ceil(input.catalog.skills.length / SKILLS_PER_PAGE),
  );
  const requestedPage = input.page ?? 1;
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const start = (page - 1) * SKILLS_PER_PAGE;
  const skills = input.catalog.skills.slice(start, start + SKILLS_PER_PAGE);
  const lines = [
    `**Available skills (${input.catalog.skills.length}) — page ${page}/${pageCount}**`,
    ...skills.map(
      (skill) =>
        `- \`$${skill.invocation ?? skill.name}\` — ${formatSkillDescription(skill)}`,
    ),
    '',
    'Invoke a skill by starting your request with its exact token, for example: `$review-code review these changes`.',
  ];
  if (page < pageCount)
    lines.push(`Next page: \`${input.command} ${page + 1}\`.`);
  if (requestedPage !== page) {
    lines.push(`Page ${requestedPage} is unavailable; showing page ${page}.`);
  }
  if (input.catalog.warnings.length > 0) {
    lines.push(
      `Some scoped skill sources could not be fully inspected (${input.catalog.warnings.length}); the list does not claim skills from those sources.`,
    );
  }
  return lines.join('\n');
}

export function parseSkillsCommandPage(text: string): number | null {
  const match = /^\s*\/?skills(?:\s+(\d+))?\s*$/iu.exec(text);
  if (!match) return null;
  const page = Number.parseInt(match[1] ?? '1', 10);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}
