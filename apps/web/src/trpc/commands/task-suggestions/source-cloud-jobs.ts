import { and, asc, db, eq, inArray, taskRuns } from '@roomote/db/server';
import {
  TASK_SUGGESTION_SOURCES,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  type TaskSuggestionSource,
} from '@roomote/types';

import type {
  SuggestionHistoryAutomation,
  SuggestionSourceCloudJob,
} from './types';

export const suggestionHistoryAutomationValues = [
  'onboarding',
  ...TASK_SUGGESTION_SOURCES,
] as const satisfies readonly SuggestionHistoryAutomation[];

const suggestionHistoryAutomationLabelByValue = new Map<
  SuggestionHistoryAutomation,
  string
>([
  ['onboarding', 'Onboarding'],
  ...TASK_SUGGESTION_SOURCES.map(
    (source): [SuggestionHistoryAutomation, string] => [
      source,
      getScheduledSuggestionBackgroundAutomationDescriptor(source)?.label ??
        'Suggestions',
    ],
  ),
]);

const suggestionTaskSourceSet = new Set<string>(TASK_SUGGESTION_SOURCES);

export function getSuggestionHistoryAutomation(
  cloudJob: SuggestionSourceCloudJob | undefined,
): SuggestionHistoryAutomation {
  if (!cloudJob) {
    return 'suggest_ideas';
  }

  const payload = cloudJob.payload;
  const trigger =
    payload && typeof payload === 'object' && 'trigger' in payload
      ? payload.trigger
      : undefined;
  const suggestionSource =
    payload && typeof payload === 'object' && 'suggestionSource' in payload
      ? payload.suggestionSource
      : undefined;

  if (trigger === 'onboarding') {
    return 'onboarding';
  }

  return typeof suggestionSource === 'string' &&
    suggestionTaskSourceSet.has(suggestionSource)
    ? (suggestionSource as TaskSuggestionSource)
    : 'suggest_ideas';
}

export function getSuggestionHistoryAutomationLabel(
  automation: SuggestionHistoryAutomation,
) {
  return (
    suggestionHistoryAutomationLabelByValue.get(automation) ?? 'Suggestions'
  );
}

/**
 * Returns the fresh (initial) run for each task. Suggestion history reads the
 * launch payload of the run that originally created the task; resumes attach
 * later runs to the same task, so the fresh run is the lowest-id 'fresh' row.
 */
export async function getResolvedSuggestionSourceCloudJobsByTaskId(
  taskIds: string[],
): Promise<Record<string, SuggestionSourceCloudJob>> {
  if (taskIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      taskId: taskRuns.taskId,
      payloadKind: taskRuns.payloadKind,
      payload: taskRuns.payload,
    })
    .from(taskRuns)
    .where(and(eq(taskRuns.kind, 'fresh'), inArray(taskRuns.taskId, taskIds)))
    .orderBy(taskRuns.taskId, asc(taskRuns.id));

  const freshRunByTaskId: Record<string, SuggestionSourceCloudJob> = {};

  for (const row of rows) {
    if (!(row.taskId in freshRunByTaskId)) {
      freshRunByTaskId[row.taskId] = {
        payloadKind: row.payloadKind,
        payload: row.payload,
      };
    }
  }

  return freshRunByTaskId;
}
