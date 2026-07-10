import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  repositories,
  sql,
  workItems,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { assertSuggestionHistoryEnabled } from './shared';
import {
  getResolvedSuggestionSourceCloudJobsByTaskId,
  getSuggestionHistoryAutomation,
  getSuggestionHistoryAutomationLabel,
  suggestionHistoryAutomationValues,
} from './source-cloud-jobs';
import type {
  SuggestionHistoryAutomation,
  SuggestionHistoryItem,
  SuggestionHistoryStatusFilter,
  VisibleTaskSuggestionStatus,
} from './types';

function getStatusesForHistoryFilter(
  status: SuggestionHistoryStatusFilter | undefined,
): VisibleTaskSuggestionStatus[] {
  switch (status) {
    case 'accepted':
      return ['launched'];
    case 'ignored':
      return ['dismissed'];
    case 'all':
      return ['open', 'launched', 'dismissed'];
    case 'proposed':
    case undefined:
      return ['open'];
  }
}

function parseSuggestionHistoryCursor(cursor?: string): {
  createdAt: Date;
  id: string;
} | null {
  if (!cursor) {
    return null;
  }

  const [rawCreatedAt, id] = cursor.split(':', 2);
  const createdAtMs = Number(rawCreatedAt);

  if (!id || !Number.isFinite(createdAtMs)) {
    return null;
  }

  return {
    createdAt: new Date(createdAtMs),
    id,
  };
}

function buildSuggestionRepositoryLabel(
  suggestion: {
    targetRepositoryFullName: string | null;
    repositoryIds: string[];
  },
  repositoryNameById: Map<string, string>,
) {
  if (suggestion.targetRepositoryFullName) {
    return suggestion.targetRepositoryFullName;
  }

  const repositoryNames = Array.from(
    new Set(
      suggestion.repositoryIds
        .map((repositoryId) => repositoryNameById.get(repositoryId))
        .filter((repositoryName): repositoryName is string =>
          Boolean(repositoryName),
        ),
    ),
  );

  if (repositoryNames.length === 0) {
    return 'Multiple repositories';
  }

  if (repositoryNames.length === 1) {
    return repositoryNames[0]!;
  }

  return `${repositoryNames[0]} +${repositoryNames.length - 1} more`;
}

export async function listTaskSuggestionHistoryCommand(
  auth: UserAuthSuccess,
  input: {
    limit: number;
    cursor?: string;
    automation?: SuggestionHistoryAutomation;
    repository?: string;
    status?: SuggestionHistoryStatusFilter;
  },
): Promise<{
  suggestions: SuggestionHistoryItem[];
  nextCursor?: string;
}> {
  assertSuggestionHistoryEnabled(auth);

  const parsedCursor = parseSuggestionHistoryCursor(input.cursor);
  const statuses = getStatusesForHistoryFilter(input.status);

  const conditions = [
    eq(workItems.kind, 'suggestion'),
    inArray(workItems.status, statuses),
  ];

  if (input.repository) {
    const [selectedRepository] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.fullName, input.repository))
      .limit(1);

    if (selectedRepository) {
      conditions.push(
        sql`(
          ${workItems.targetRepositoryFullName} = ${input.repository}
          OR (
            ${workItems.targetRepositoryFullName} IS NULL
            AND ${workItems.repositoryIds} @> ${JSON.stringify([selectedRepository.id])}::jsonb
          )
        )`,
      );
    } else {
      conditions.push(eq(workItems.targetRepositoryFullName, input.repository));
    }
  }

  if (input.automation) {
    const candidateSourceTaskRows = await db
      .selectDistinct({ sourceTaskId: workItems.sourceTaskId })
      .from(workItems)
      .where(and(...conditions, isNotNull(workItems.sourceTaskId)));

    const candidateSourceTaskIds = candidateSourceTaskRows
      .map((row) => row.sourceTaskId)
      .filter((taskId): taskId is string => Boolean(taskId));

    const resolvedSourceJobsByTaskId =
      await getResolvedSuggestionSourceCloudJobsByTaskId(
        candidateSourceTaskIds,
      );

    const matchingSourceTaskIds = candidateSourceTaskIds.filter(
      (taskId) =>
        getSuggestionHistoryAutomation(resolvedSourceJobsByTaskId[taskId]) ===
        input.automation,
    );

    const nullSourceMatches = input.automation === 'suggest_ideas';

    if (matchingSourceTaskIds.length === 0 && !nullSourceMatches) {
      return {
        suggestions: [],
        nextCursor: undefined,
      };
    }

    if (matchingSourceTaskIds.length > 0 && nullSourceMatches) {
      conditions.push(
        or(
          inArray(workItems.sourceTaskId, matchingSourceTaskIds),
          sql`${workItems.sourceTaskId} IS NULL`,
        )!,
      );
    } else if (matchingSourceTaskIds.length > 0) {
      conditions.push(inArray(workItems.sourceTaskId, matchingSourceTaskIds));
    } else {
      conditions.push(sql`${workItems.sourceTaskId} IS NULL`);
    }
  }

  if (parsedCursor) {
    const cursorCreatedAtIso = parsedCursor.createdAt.toISOString();

    conditions.push(
      sql`(
        ${workItems.createdAt} < ${cursorCreatedAtIso}
        OR (
          ${workItems.createdAt} = ${cursorCreatedAtIso}
          AND ${workItems.id} < ${parsedCursor.id}
        )
      )`,
    );
  }

  const rows = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      category: workItems.category,
      priority: workItems.priority,
      investigationContext: workItems.investigationContext,
      readinessMessage: workItems.readinessMessage,
      repositoryIds: workItems.repositoryIds,
      targetRepositoryFullName: workItems.targetRepositoryFullName,
      status: workItems.status,
      createdAt: workItems.createdAt,
      sourceTaskId: workItems.sourceTaskId,
    })
    .from(workItems)
    .where(and(...conditions))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const sourceTaskIds = Array.from(
    new Set(
      pageRows
        .map((suggestion) => suggestion.sourceTaskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    ),
  );
  const repositoryIds = Array.from(
    new Set(pageRows.flatMap((suggestion) => suggestion.repositoryIds)),
  );

  const [resolvedSourceJobsByTaskId, repositoryRows] = await Promise.all([
    getResolvedSuggestionSourceCloudJobsByTaskId(sourceTaskIds),
    repositoryIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: repositories.id,
            fullName: repositories.fullName,
          })
          .from(repositories)
          .where(inArray(repositories.id, repositoryIds)),
  ]);

  const repositoryNameById = new Map(
    repositoryRows.map((repository) => [repository.id, repository.fullName]),
  );

  const suggestions = pageRows.map((suggestion) => {
    const automation = getSuggestionHistoryAutomation(
      suggestion.sourceTaskId
        ? resolvedSourceJobsByTaskId[suggestion.sourceTaskId]
        : undefined,
    );
    const status: VisibleTaskSuggestionStatus =
      suggestion.status === 'dismissed'
        ? 'dismissed'
        : suggestion.status === 'launched'
          ? 'launched'
          : 'open';

    return {
      id: suggestion.id,
      title: suggestion.title,
      brief: suggestion.brief ?? '',
      status,
      createdAt: suggestion.createdAt,
      automation,
      automationLabel: getSuggestionHistoryAutomationLabel(automation),
      repositoryLabel: buildSuggestionRepositoryLabel(
        suggestion,
        repositoryNameById,
      ),
      category: suggestion.category,
      priority: suggestion.priority,
      investigationContext: suggestion.investigationContext,
      readinessMessage: suggestion.readinessMessage,
    } satisfies SuggestionHistoryItem;
  });

  const lastSuggestion = suggestions.at(-1);

  return {
    suggestions,
    nextCursor: hasMore
      ? `${lastSuggestion!.createdAt.getTime()}:${lastSuggestion!.id}`
      : undefined,
  };
}

export async function getTaskSuggestionFilterOptionsCommand(
  auth: UserAuthSuccess,
): Promise<{
  automations: Array<{ value: SuggestionHistoryAutomation; label: string }>;
  repositories: Array<{ value: string; label: string }>;
}> {
  assertSuggestionHistoryEnabled(auth);
  const visibleStatuses = getStatusesForHistoryFilter('all');

  const suggestionRows = await db
    .select({
      targetRepositoryFullName: workItems.targetRepositoryFullName,
      repositoryIds: workItems.repositoryIds,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, 'suggestion'),
        inArray(workItems.status, visibleStatuses),
      ),
    );

  const repositoryIds = Array.from(
    new Set(suggestionRows.flatMap((suggestion) => suggestion.repositoryIds)),
  );

  const repositoryRows =
    repositoryIds.length === 0
      ? []
      : await db
          .select({
            id: repositories.id,
            fullName: repositories.fullName,
          })
          .from(repositories)
          .where(inArray(repositories.id, repositoryIds));

  const repositoryNameById = new Map(
    repositoryRows.map((repository) => [repository.id, repository.fullName]),
  );

  const repositoriesForFilter = Array.from(
    new Set(
      suggestionRows.flatMap((suggestion) => {
        const names = suggestion.repositoryIds
          .map((repositoryId) => repositoryNameById.get(repositoryId))
          .filter((repositoryName): repositoryName is string =>
            Boolean(repositoryName),
          );

        return suggestion.targetRepositoryFullName
          ? [suggestion.targetRepositoryFullName]
          : names;
      }),
    ),
  )
    .sort((left, right) => left.localeCompare(right))
    .map((repositoryName) => ({
      value: repositoryName,
      label: repositoryName,
    }));

  return {
    automations: suggestionHistoryAutomationValues.map((automation) => ({
      value: automation,
      label: getSuggestionHistoryAutomationLabel(automation),
    })),
    repositories: repositoriesForFilter,
  };
}
