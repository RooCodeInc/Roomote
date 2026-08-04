import {
  type EnvironmentConfig,
  RunStatus,
  PRODUCT_NAME,
} from '@roomote/types';

import { configToYaml } from '@/components/settings/environments/yaml-utils';

type EnvironmentDefinitionLike = {
  name: string;
  description?: string | null;
  config: EnvironmentConfig;
};

type EnvironmentDefinitionRecordLike = {
  id: string;
  config: EnvironmentConfig;
  createdAt: Date | string | number;
  updatedAt?: Date | string | number;
};

export function buildSetupEnvironmentTaskTitle(repositoryFullNames: string[]) {
  const repositoryNames = repositoryFullNames
    .map((fullName) => fullName.split('/').at(-1)?.trim() || fullName.trim())
    .filter(Boolean);

  if (repositoryNames.length === 0) {
    return 'Set up your first environment';
  }

  return `Set up the ${repositoryNames.join(' + ')} environment`;
}

function toComparableTimestamp(value: Date | string | number | null): number {
  if (!value) {
    return Number.NaN;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return new Date(value).getTime();
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
    )
    .join(',')}}`;
}

export function buildEnvironmentDefinitionFingerprint(
  environment: EnvironmentDefinitionLike,
): string {
  return stableSerialize({
    name: environment.name,
    description: environment.description ?? null,
    config: environment.config,
  });
}

export function hasEnvironmentDefinitionChanged(
  environment: EnvironmentDefinitionLike | null | undefined,
  baselineFingerprint: string | null | undefined,
): boolean {
  if (!environment || !baselineFingerprint) {
    return false;
  }

  return (
    buildEnvironmentDefinitionFingerprint(environment) !== baselineFingerprint
  );
}

export function buildUpdateEnvironmentDefinitionPrompt(input: {
  environmentId: string;
  environmentName: string;
  repositoryFullNames: string[];
  config: EnvironmentConfig;
}): string {
  const orderedRepositories = [...new Set(input.repositoryFullNames)];

  const repositoryLines = orderedRepositories
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');

  return `$environment-setup

Update the existing ${PRODUCT_NAME} environment definition instead of creating a new one.

Existing environment:
- ID: ${input.environmentId}
- Name: ${input.environmentName}

Repositories to inspect:
${repositoryLines}

Current environment YAML:
\`\`\`yaml
${configToYaml(input.config).trim()}
\`\`\`

Focus on the smallest correct revision that keeps this setup target running locally.
Keep the existing environment name unless the user explicitly asked to rename it.
Do not treat clearly pre-existing repository test failures as an automatic blocker if install/start validation succeeds and the failure does not point to an environment-definition problem.
When validation is sufficient, update the existing environment using the ${PRODUCT_NAME} environment tool with action "update" and environmentId "${input.environmentId}".
Do not create a duplicate environment.`;
}

/**
 * Prompt for the preview pane's "fix previews with an agent" action. Unlike
 * the definition prompts above, this deliberately does NOT invoke the
 * `$environment-setup` skill: that workflow prohibits application source
 * changes, and app-level fixes (framing headers, CORS, allowed hosts) are
 * exactly what broken previews often need. The task runs inside the
 * environment, so it can verify fixes end-to-end through the public preview
 * origin.
 */
export function buildEnvironmentPreviewRepairPrompt(input: {
  environmentId: string;
  environmentName: string;
  config: EnvironmentConfig;
}): string {
  return `Fix live previews for the ${PRODUCT_NAME} environment "${input.environmentName}" (id ${input.environmentId}).

Live previews are configured for this environment, but the user reports the preview does not load or work correctly behind the preview proxy. You are running inside the environment, so its commands and services have already started, and each configured port's public preview origin is available in the sandbox as \`ROOMOTE_<PORT_NAME>_HOST\`.

Current environment YAML:
\`\`\`yaml
${configToYaml(input.config).trim()}
\`\`\`

1. Reproduce: check each configured port's surface on localhost, then through its public preview origin from \`ROOMOTE_<PORT_NAME>_HOST\`. Compare the two to isolate proxy-specific failures.
2. Diagnose the common causes: dev servers that reject unknown hosts (allowed-hosts or host-header checks) or listen only on a loopback interface, hardcoded localhost or 127.0.0.1 origins in client code or API calls, CORS failures on cross-origin API requests, response headers that block framing (\`X-Frame-Options\`, \`Content-Security-Policy\` \`frame-ancestors\`), and websocket or HMR endpoints that bypass the proxy.
3. Fix the root cause:
   - For environment-definition problems (commands, env vars, port settings, services, docker projects), update the environment using the ${PRODUCT_NAME} MCP tool \`manage_environments\` with \`action: "update"\` and \`environmentId: "${input.environmentId}"\`. Keep every other environment setting unchanged.
   - For application code problems, make the smallest correct code change, restart the affected service so the running sandbox picks it up, and open a pull request with the change.
4. Verify end-to-end before declaring success: request the preview origin again from inside the sandbox after your fix and confirm it responds with the expected content and no framing or CORS blockers.

If the fix requires credentials, external infrastructure, or a decision you cannot safely make, report that blocker clearly instead of guessing.`;
}

function environmentIncludesRepositorySet(
  config: EnvironmentConfig,
  selectedRepositoryFullNames: string[],
): boolean {
  if (selectedRepositoryFullNames.length === 0) {
    return false;
  }

  const configuredRepositories = new Set(
    (config.repositories ?? []).map((repository) =>
      repository.repository.toLowerCase(),
    ),
  );

  return selectedRepositoryFullNames.every((repositoryFullName) =>
    configuredRepositories.has(repositoryFullName.toLowerCase()),
  );
}

export function findMatchingDefinedEnvironment<
  T extends EnvironmentDefinitionRecordLike,
>(
  environments: T[],
  selectedRepositoryFullNames: string[],
  taskStartedAt?: Date | string | null,
): T | null {
  if (selectedRepositoryFullNames.length === 0) {
    return null;
  }

  const startedAtMs = toComparableTimestamp(taskStartedAt ?? null);
  const hasTimeFilter = Number.isFinite(startedAtMs);

  const matchingEnvironments = environments
    .filter((environment) => {
      if (
        !environmentIncludesRepositorySet(
          environment.config,
          selectedRepositoryFullNames,
        )
      ) {
        return false;
      }

      if (hasTimeFilter) {
        const createdAtMs = toComparableTimestamp(environment.createdAt);

        return Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs;
      }

      return true;
    })
    .sort(
      (left, right) =>
        toComparableTimestamp(left.createdAt) -
        toComparableTimestamp(right.createdAt),
    );

  return matchingEnvironments[0] ?? null;
}

export function wasEnvironmentUpdatedAfter(
  environment: Pick<EnvironmentDefinitionRecordLike, 'updatedAt'> | null,
  taskStartedAt: Date | string | null,
): boolean {
  const updatedAtMs = toComparableTimestamp(environment?.updatedAt ?? null);
  const startedAtMs = toComparableTimestamp(taskStartedAt);

  return Number.isFinite(updatedAtMs) && Number.isFinite(startedAtMs)
    ? updatedAtMs >= startedAtMs
    : false;
}

export function isEnvironmentDefinitionTerminalSuccessStatus(
  status: RunStatus | null | undefined,
  taskPhase?: string | null,
): boolean {
  return (
    status === RunStatus.Completed ||
    (status === RunStatus.Idle && taskPhase === 'waiting_for_prompt')
  );
}

export function isEnvironmentDefinitionSuccessStatus(
  status: RunStatus | null | undefined,
  taskPhase?: string | null,
): boolean {
  return isEnvironmentDefinitionTerminalSuccessStatus(status, taskPhase);
}

export function isEnvironmentDefinitionFailureStatus(
  status: RunStatus | null | undefined,
): boolean {
  return status === RunStatus.Failed || status === RunStatus.Canceled;
}
