import {
  type EnvironmentConfig,
  CloudTaskStatus,
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
  const sortedRepositories = [...input.repositoryFullNames].sort(
    (left, right) => left.localeCompare(right),
  );

  const repositoryLines = sortedRepositories
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
  status: CloudTaskStatus | null | undefined,
  taskPhase?: string | null,
): boolean {
  return (
    status === CloudTaskStatus.Completed ||
    (status === CloudTaskStatus.Idle && taskPhase === 'waiting_for_prompt')
  );
}

export function isEnvironmentDefinitionSuccessStatus(
  status: CloudTaskStatus | null | undefined,
  taskPhase?: string | null,
): boolean {
  return isEnvironmentDefinitionTerminalSuccessStatus(status, taskPhase);
}

export function isEnvironmentDefinitionFailureStatus(
  status: CloudTaskStatus | null | undefined,
): boolean {
  return (
    status === CloudTaskStatus.Failed || status === CloudTaskStatus.Canceled
  );
}
