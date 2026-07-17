import { ALL_REPOSITORIES, PRODUCT_NAME } from './constants';

type RepositoryReference = {
  id: string;
  fullName: string;
};

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

  return `$environment-setup

Set up a ${PRODUCT_NAME} environment for this repository set:
${repositoryLines}

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

/**
 * Canned change request for the preview pane's "preview not working" help
 * flow: the environment already publishes a preview URL, but the app does not
 * load or behave correctly behind the preview proxy.
 */
export const ENVIRONMENT_PREVIEW_REPAIR_CHANGE_REQUEST = `Live previews are configured for this environment, but the user reports the preview does not load or work correctly. You are running inside the environment, so its commands and services have already started. Validate each configured port's surface on localhost and diagnose why it would fail behind the preview proxy. Check the common causes: dev servers that reject unknown hosts (allowed-hosts or host-header checks) or listen only on a loopback interface, hardcoded localhost or 127.0.0.1 origins in client code or API calls (the sandbox exposes the public preview origin for each port as \`ROOMOTE_<PORT_NAME>_HOST\`), CORS failures on cross-origin API requests, response headers that block framing (\`X-Frame-Options\`, \`Content-Security-Policy\` \`frame-ancestors\`), and websocket or HMR endpoints that bypass the proxy. Fix what can be fixed through the environment definition: commands, env vars, port settings, services, and docker projects. If the fix requires application source-code changes (for example framing or CORS headers set by the app, or an allowed-hosts list checked into the repo), do not modify application code in this task; report exactly which files need which changes as the blocker outcome so the user can apply them in a normal coding task. Keep every other environment setting unchanged.`;

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
