import { ALL_REPOSITORIES, PRODUCT_NAME } from './constants';

type RepositoryReference = {
  id: string;
  fullName: string;
};

export function assertUniqueRepositoryFullNames(
  repositoryFullNames: string[],
): void {
  const duplicateRepository = repositoryFullNames.find(
    (repository, index) => repositoryFullNames.indexOf(repository) !== index,
  );

  if (duplicateRepository) {
    throw new Error(
      `The selected repositories include multiple entries named "${duplicateRepository}". Select only one because task workspaces identify repositories by full name.`,
    );
  }
}

export const ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER =
  'Optional agent guidance, like what services in a monorepo to set up or context that may be missing from the repo itself';

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
  return [...new Set(repositories.map((repository) => repository.id))];
}

export function buildCreateEnvironmentDefinitionPrompt(
  repositoryFullNames: string[],
  options?: { emptyRepositoryFullNames?: string[] },
): string {
  const orderedRepositories = [...new Set(repositoryFullNames)];

  const repositoryLines = orderedRepositories
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');

  const emptyRepositoryNames = new Set(options?.emptyRepositoryFullNames ?? []);
  const emptyRepositories = orderedRepositories.filter((fullName) =>
    emptyRepositoryNames.has(fullName),
  );

  // Restate the skill's empty-repository bootstrap rules inline so a worker
  // whose packaged environment-setup skill predates the bootstrap section
  // still degrades gracefully instead of failing on the empty checkout.
  const emptyRepositorySection =
    emptyRepositories.length > 0
      ? `\n\nThese repositories are brand new and have no commits yet:
${emptyRepositories.map((fullName) => `- ${fullName}`).join('\n')}

For each empty repository, follow the skill's empty-repository bootstrap: push exactly one initial commit containing only a README.md and a minimal .gitignore to its default branch (never force-push), then define the smallest valid environment for it — typically the repository mapping alone, with no commands, services, or ports. Do not scaffold application code, frameworks, package manifests, or CI config; building the actual project is the user's next task.`
      : '';

  return `$environment-setup

Set up a ${PRODUCT_NAME} environment for this repository set:
${repositoryLines}${emptyRepositorySection}

Focus on the smallest correct environment that gets this setup target running locally.
Use a plain, stable environment name based on the product or repository name. Do not append qualifiers like "Localhost", "Minimal", or similar unless the user explicitly asked for that distinction.
Do not mock or stub required services just to make the environment appear to work.
If you cannot figure out how to get a required real service running, ask the user for help instead of inventing a fallback.
Do not treat clearly pre-existing repository test failures as an automatic blocker if install/start validation succeeds and the failure does not point to an environment-definition problem.
Create the environment when validation is sufficient.`;
}

/**
 * Prompt for a standalone environment verification task launched by the
 * verification-retry command. The task runs inside the target environment and
 * must record its result through the `record_verification` MCP action.
 */
export function buildEnvironmentVerificationPrompt(input: {
  environmentId: string;
  environmentName: string;
}): string {
  return `Verify that the ${PRODUCT_NAME} environment "${input.environmentName}" (id ${input.environmentId}) is running correctly.

Use localhost or the environment's initial URL to confirm the expected service responds successfully, and confirm there are no obvious startup failures blocking basic use. Preparing the environment can take 5 minutes or more, so be patient before deciding startup is stuck.

When you have a clear outcome, record it by calling the ${PRODUCT_NAME} MCP tool \`manage_environments\` with \`action: "record_verification"\`, \`environmentId: "${input.environmentId}"\`, and \`success: true\` when the environment looks ready or \`success: false\` with a short, user-safe \`error\` describing what failed. Do not include secrets or the full environment YAML in the error text.`;
}

/**
 * Canned change request for the preview pane's "set up previews with an agent"
 * CTA. Appended to the update-environment prompt so the environment-setup
 * skill focuses on publishing live preview ports.
 */
export const ENVIRONMENT_PREVIEW_SETUP_CHANGE_REQUEST = `Get live previews working for this environment. You are running inside the environment, so its commands and services have already started. Identify the human-facing web UI surface(s), validate that each one serves HTTP on localhost, and add a matching top-level \`ports\` entry for each: short uppercase \`name\`, the validated port, \`initial_path\` when a specific landing path is better than \`/\`, and \`primary: true\` on the main surface. If the config contains \`previews_enabled: false\`, remove it; that flag is deprecated and ignored. Keep every other environment setting unchanged unless it blocks the app from starting.`;

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
  assertUniqueRepositoryFullNames(repositoryFullNames);
  const normalizedRepositories = [...new Set(repositoryFullNames)];
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
