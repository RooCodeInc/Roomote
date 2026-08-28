import {
  ALL_REPOSITORIES,
  formatExternalActorLabel,
  normalizeExternalActorId,
  PRODUCT_NAME,
  type TaskSurface,
} from '@roomote/types';
import { environments } from '@roomote/db/server';

import {
  type AnalyticsDimension,
  type AnalyticsFilterOption,
  type AnalyticsFilterOptionsResponse,
  type AnalyticsFilters,
  type AnalyticsObject,
  ANALYTICS_OBJECT_CONFIG,
} from '@/types';
import { getUserDisplayName } from '@/lib/user-display-name';
import { formatAutomationLabel } from '@/lib/task-creator-filter';
import { getTaskSurfaceLabel } from '@/lib/task-surface-label';

import {
  ALL_REPOS_LABEL,
  NO_VALUE_LABEL,
  PR_STATUS_ORDER,
  SOURCE_ORDER,
  SYSTEM_SOURCE,
  type AnalyticsDimensionValue,
  type AnalyticsRow,
} from './types';

function formatUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  return getUserDisplayName(user) || PRODUCT_NAME;
}

function formatDisambiguatedUserLabel(
  user: { name: string | null; email: string | null } | null,
) {
  const displayName = getUserDisplayName(user);

  if (displayName && user?.email) {
    return `${displayName} (${user.email})`;
  }

  return formatUserLabel(user);
}

export function createDimensionValue(
  key: string,
  label: string,
  disambiguationLabel?: string,
): AnalyticsDimensionValue {
  return {
    key,
    label,
    ...(disambiguationLabel &&
    disambiguationLabel !== label &&
    disambiguationLabel.trim()
      ? { disambiguationLabel }
      : {}),
  };
}

export function createLabelBackedDimensionValue(label: string) {
  return createDimensionValue(label, label);
}

export function getCanonicalUserDimensionValue(user: {
  id: string | null;
  name: string | null;
  email: string | null;
}) {
  const label = formatUserLabel(user);
  const normalizedEmail = user.email?.trim().toLowerCase() ?? null;
  const key = user.id
    ? `user:${user.id}`
    : normalizedEmail
      ? `email:${normalizedEmail}`
      : PRODUCT_NAME;

  return createDimensionValue(key, label, formatDisambiguatedUserLabel(user));
}

/**
 * Creator dimension: a pure function of the tasks initiator columns
 * (GROUP BY initiatorKind + COALESCE(initiatorUserId, initiatorAutomation,
 * actorExternalId) semantics, computed per row).
 */
export function getTaskInitiatorDimensionValue(input: {
  initiatorKind: 'user' | 'automation';
  initiatorUserId: string | null;
  initiatorAutomation: string | null;
  actorExternalId: string | null;
  actorDisplayName: string | null;
  userName: string | null;
  userEmail: string | null;
}) {
  if (input.initiatorKind === 'automation') {
    const key = input.initiatorAutomation ?? PRODUCT_NAME;
    const label = input.initiatorAutomation
      ? formatAutomationLabel(input.initiatorAutomation, {
          actorDisplayName: input.actorDisplayName,
        })
      : PRODUCT_NAME;

    return createDimensionValue(`automation:${key}`, label);
  }

  if (input.initiatorUserId) {
    return getCanonicalUserDimensionValue({
      id: input.initiatorUserId,
      name: input.userName,
      email: input.userEmail,
    });
  }

  const externalId = normalizeExternalActorId(input.actorExternalId);
  const externalLabel = formatExternalActorLabel(input) ?? NO_VALUE_LABEL;

  return createDimensionValue(
    externalId ? `external:${externalId}` : `external:${externalLabel}`,
    externalLabel,
  );
}

export function formatRepositoryLabel(repositoryName: string) {
  return repositoryName === ALL_REPOSITORIES ? ALL_REPOS_LABEL : repositoryName;
}

export function mapTaskSource(surface: TaskSurface | null | undefined) {
  return getTaskSurfaceLabel(surface) ?? SYSTEM_SOURCE;
}

type ProjectNameMatch = {
  label: string;
  isPrimary: boolean;
  repoCount: number;
};

function shouldReplaceProjectNameMatch(
  existing: ProjectNameMatch | undefined,
  candidate: ProjectNameMatch,
) {
  if (!existing) {
    return true;
  }

  if (existing.isPrimary !== candidate.isPrimary) {
    return candidate.isPrimary;
  }

  if (existing.repoCount !== candidate.repoCount) {
    return candidate.repoCount < existing.repoCount;
  }

  return false;
}

export function buildProjectNameByRepoMap(
  environmentRows: Array<{
    id: string;
    name: string;
    config: typeof environments.$inferSelect.config;
  }>,
) {
  const projectNameByRepo = new Map<string, ProjectNameMatch>();

  for (const environment of environmentRows) {
    const repositories = environment.config?.repositories ?? [];

    for (const [index, repository] of repositories.entries()) {
      const repoKey = repository.repository.toLowerCase();
      const candidate: ProjectNameMatch = {
        label: environment.name,
        isPrimary: index === 0,
        repoCount: repositories.length,
      };

      if (
        shouldReplaceProjectNameMatch(projectNameByRepo.get(repoKey), candidate)
      ) {
        projectNameByRepo.set(repoKey, candidate);
      }
    }
  }

  return new Map(
    [...projectNameByRepo.entries()].map(([repo, match]) => [
      repo,
      match.label,
    ]),
  );
}
function getDimensionSortOrder(dimension: AnalyticsDimension) {
  if (dimension === 'source') {
    return SOURCE_ORDER;
  }

  if (dimension === 'status') {
    return [...PR_STATUS_ORDER];
  }

  return null;
}

export function compareDimensionValues(
  dimension: AnalyticsDimension,
  left: string,
  right: string,
) {
  const order = getDimensionSortOrder(dimension);

  if (order) {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    }
  }

  return left.localeCompare(right);
}

export function applyDimensionFilters<TRow extends AnalyticsRow>(
  rows: TRow[],
  filters: AnalyticsFilters,
  omitDimension?: AnalyticsDimension,
) {
  return rows.filter((row) => {
    for (const [dimension, values] of Object.entries(filters) as [
      AnalyticsDimension,
      string[],
    ][]) {
      if (!values || values.length === 0 || dimension === omitDimension) {
        continue;
      }

      const dimensionValue = row.dimensions[dimension];

      if (
        dimension === 'taskType' &&
        values.includes('all-automated') &&
        dimensionValue?.key.startsWith('automation:')
      ) {
        continue;
      }

      if (!dimensionValue) {
        return false;
      }

      if (
        !values.includes(dimensionValue.key) &&
        !values.includes(dimensionValue.label)
      ) {
        return false;
      }
    }

    return true;
  });
}

export function buildFilterOptions<TRow extends AnalyticsRow>(
  rows: TRow[],
  object: AnalyticsObject,
  filters: AnalyticsFilters,
): AnalyticsFilterOptionsResponse {
  const config = ANALYTICS_OBJECT_CONFIG[object];
  const result: Partial<Record<AnalyticsDimension, AnalyticsFilterOption[]>> =
    {};

  for (const dimension of config.filterDimensions) {
    const options = new Map<string, string>();
    const dimensionRows = applyDimensionFilters(rows, filters, dimension);

    for (const row of dimensionRows) {
      const value = row.dimensions[dimension];
      if (value) {
        options.set(value.key, value.label);
      }
    }

    result[dimension] = [...options.entries()]
      .sort((left, right) =>
        compareDimensionValues(dimension, left[1], right[1]),
      )
      .map(([value, label]) => ({ value, label }));

    if (
      dimension === 'taskType' &&
      result[dimension]?.some((option) =>
        option.value.startsWith('automation:'),
      )
    ) {
      result[dimension] = [
        { value: 'all-automated', label: 'All automated' },
        ...(result[dimension] ?? []),
      ];
    }
  }

  return {
    filters: result,
    availableViewBy: config.viewByDimensions,
  };
}
export function getPullRequestKey(
  repository: string,
  prNumber: number,
  provider = 'github',
  host = 'github.com',
) {
  return `${provider.toLowerCase()}:${host.toLowerCase()}:${repository.toLowerCase()}#${prNumber}`;
}

export function resolveDimensionLabelCollisions<TRow extends AnalyticsRow>(
  rows: TRow[],
) {
  const labelsByDimension = new Map<
    AnalyticsDimension,
    Map<string, Set<string>>
  >();

  for (const row of rows) {
    for (const [dimension, value] of Object.entries(row.dimensions) as [
      AnalyticsDimension,
      AnalyticsDimensionValue,
    ][]) {
      const labelsForDimension =
        labelsByDimension.get(dimension) ?? new Map<string, Set<string>>();
      const keysForLabel =
        labelsForDimension.get(value.label) ?? new Set<string>();
      keysForLabel.add(value.key);
      labelsForDimension.set(value.label, keysForLabel);
      labelsByDimension.set(dimension, labelsForDimension);
    }
  }

  for (const row of rows) {
    for (const [dimension, value] of Object.entries(row.dimensions) as [
      AnalyticsDimension,
      AnalyticsDimensionValue,
    ][]) {
      const collidingKeys = labelsByDimension.get(dimension)?.get(value.label);

      if (
        collidingKeys &&
        collidingKeys.size > 1 &&
        value.disambiguationLabel
      ) {
        value.label = value.disambiguationLabel;
      }
    }
  }

  return rows;
}

export function getTaskTypeDimensionValue(task: {
  initiatorKind: 'user' | 'automation' | null;
  initiatorAutomation: string | null;
  actorDisplayName?: string | null;
}) {
  if (!task.initiatorKind) {
    return createLabelBackedDimensionValue('Unknown Task');
  }

  if (task.initiatorKind === 'automation') {
    const key = task.initiatorAutomation ?? 'unknown';
    const label = task.initiatorAutomation
      ? formatAutomationLabel(task.initiatorAutomation, {
          actorDisplayName: task.actorDisplayName,
        })
      : 'Unknown';
    return createDimensionValue(
      `automation:${key}`,
      label === 'Automation' ? label : `${label} Task`,
    );
  }

  return createLabelBackedDimensionValue('Manual Task');
}
