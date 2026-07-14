import { ALL_REPOSITORIES, PRODUCT_NAME } from './constants';

type RepositoryReference = {
  id: string;
  fullName: string;
};

export const ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER =
  'Optional agent guidance, like what services in a monorepo to set up or context that may be missing from the repo itself';

/**
 * Skill invocation prefix that marks a task prompt as an environment-setup
 * task. The worker keys runtime affordances (like the brief-targeted proof
 * runner) off this prefix, so prompt builders must keep it as the first line.
 */
export const ENVIRONMENT_SETUP_SKILL_INVOCATION = '$environment-setup';

export function isEnvironmentSetupTaskPrompt(
  prompt: string | null | undefined,
): boolean {
  const trimmed = prompt?.trimStart();

  if (!trimmed?.startsWith(ENVIRONMENT_SETUP_SKILL_INVOCATION)) {
    return false;
  }

  const nextChar = trimmed[ENVIRONMENT_SETUP_SKILL_INVOCATION.length];
  return nextChar === undefined || /\s/.test(nextChar);
}

export const ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_MAX_LENGTH = 8_000;

export function getEnvironmentDefinitionIdFromPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;
  const value =
    payloadRecord.environmentDefinitionId ??
    payloadRecord.projectDefinitionEnvironmentId;

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeRepositorySelection(
  repositories: RepositoryReference[],
): string[] {
  const uniqueRepositories = Array.from(
    new Map(
      repositories.map((repository) => [repository.id, repository]),
    ).values(),
  );

  return uniqueRepositories
    .sort(
      (left, right) =>
        left.fullName.localeCompare(right.fullName) ||
        left.id.localeCompare(right.id),
    )
    .map((repository) => repository.id);
}

export function buildCreateEnvironmentDefinitionPrompt(
  repositoryFullNames: string[],
): string {
  const sortedRepositories = [...repositoryFullNames].sort((left, right) =>
    left.localeCompare(right),
  );

  const repositoryLines = sortedRepositories
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');

  return `${ENVIRONMENT_SETUP_SKILL_INVOCATION}

Set up a ${PRODUCT_NAME} environment for this repository set:
${repositoryLines}

Focus on the smallest correct environment that gets this setup target running locally.
Use a plain, stable environment name based on the product or repository name. Do not append qualifiers like "Localhost", "Minimal", or similar unless the user explicitly asked for that distinction.
Do not mock or stub required services just to make the environment appear to work.
If you cannot figure out how to get a required real service running, ask the user for help instead of inventing a fallback.
Do not treat clearly pre-existing repository test failures as an automatic blocker if install/start validation succeeds and the failure does not point to an environment-definition problem.
Create the environment when validation is sufficient.`;
}

export function appendEnvironmentDefinitionGuidance(
  prompt: string,
  guidance: string | null | undefined,
  heading = 'Additional setup guidance from the user:',
): string {
  const trimmedGuidance = guidance?.trim();

  if (!trimmedGuidance) {
    return prompt;
  }

  return `${prompt}

${heading}
${trimmedGuidance}`;
}

export function buildEnvironmentDefinitionWorkspacePayload(
  repositoryFullNames: string[],
): {
  repo: string;
  selectedRepositories?: string[];
} {
  const normalizedRepositories = [...new Set(repositoryFullNames)].sort(
    (left, right) => left.localeCompare(right),
  );
  const primaryRepository = normalizedRepositories[0];

  if (!primaryRepository) {
    throw new Error('Select at least one repository before starting setup.');
  }

  if (normalizedRepositories.length === 1) {
    return { repo: primaryRepository };
  }

  return {
    repo: ALL_REPOSITORIES,
    selectedRepositories: normalizedRepositories,
  };
}
