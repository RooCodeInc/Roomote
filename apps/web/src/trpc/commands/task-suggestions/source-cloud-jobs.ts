import { cloudJobs, db, desc, inArray } from '@roomote/db/server';
import {
  CloudTaskType,
  TASK_SUGGESTION_SOURCES,
  getScheduledSuggestionBackgroundAutomationDescriptor,
  type CloudTaskPayload,
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
  cloudJob:
    | {
        type: CloudTaskType;
        payload: CloudTaskPayload;
      }
    | undefined,
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

  if (
    trigger === 'onboarding' ||
    cloudJob.type === CloudTaskType.LegacyOnboardingSuggestions
  ) {
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

function resolveSuggestionSourceCloudJob(
  latestJob: SuggestionSourceCloudJob,
  jobsById: Map<number, SuggestionSourceCloudJob>,
): SuggestionSourceCloudJob {
  const visitedIds = new Set<number>();
  let currentJob = latestJob;

  while (
    currentJob.sourceCloudJobId &&
    !visitedIds.has(currentJob.sourceCloudJobId)
  ) {
    visitedIds.add(currentJob.id);

    const sourceJob = jobsById.get(currentJob.sourceCloudJobId);

    if (!sourceJob) {
      break;
    }

    currentJob = sourceJob;
  }

  return currentJob;
}

export async function getResolvedSuggestionSourceCloudJobsByTaskId(
  taskIds: string[],
): Promise<
  Record<
    string,
    {
      type: CloudTaskType;
      payload: CloudTaskPayload;
    }
  >
> {
  if (taskIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      id: cloudJobs.id,
      taskId: cloudJobs.taskId,
      type: cloudJobs.type,
      payload: cloudJobs.payload,
      sourceCloudJobId: cloudJobs.sourceCloudJobId,
    })
    .from(cloudJobs)
    .where(inArray(cloudJobs.taskId, taskIds))
    .orderBy(cloudJobs.taskId, desc(cloudJobs.id));

  const jobsById = new Map<number, SuggestionSourceCloudJob>();
  const latestJobsByTaskId = new Map<string, SuggestionSourceCloudJob>();

  for (const row of rows) {
    jobsById.set(row.id, row);

    if (!latestJobsByTaskId.has(row.taskId)) {
      latestJobsByTaskId.set(row.taskId, row);
    }
  }

  return Object.fromEntries(
    Array.from(latestJobsByTaskId.entries()).map(([taskId, latestJob]) => {
      const resolvedJob = resolveSuggestionSourceCloudJob(latestJob, jobsById);

      return [
        taskId,
        {
          type: resolvedJob.type,
          payload: resolvedJob.payload,
        },
      ];
    }),
  );
}
