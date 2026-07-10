import {
  type TaskSpec,
  type CodingHarness,
  type HarnessModelOverrides,
  type TaskModelSettings,
  TaskPayloadKind,
  getDefaultTaskModelId,
  getHarnessModelOverride,
  isTaskModelIdAllowed,
} from '@roomote/types';
import type { MetadataRecord } from '@roomote/feature-flags';

import { DEFAULT_STANDARD_TASK_MODEL } from '../task-runtime-defaults';

function isConfiguredModelId(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCodeReviewTaskType(task: TaskSpec): boolean {
  return (
    task.type === TaskPayloadKind.GithubPrReview ||
    task.type === TaskPayloadKind.GithubPrReviewSync
  );
}

function resolveTaskModelForHarness(
  harness: CodingHarness,
  harnessModelOverrides?: HarnessModelOverrides,
): string {
  if (harness !== 'opencode-server') {
    return DEFAULT_STANDARD_TASK_MODEL;
  }

  return (
    getHarnessModelOverride(harnessModelOverrides, harness) ??
    DEFAULT_STANDARD_TASK_MODEL
  );
}

function applyHarnessModelOverrides<T extends TaskSpec>(
  task: T,
  harnessModelOverrides?: HarnessModelOverrides,
): T {
  const currentOverride = getHarnessModelOverride(
    task.payload.harnessModelOverrides,
    'opencode-server',
  );

  if (!harnessModelOverrides || currentOverride) {
    return task;
  }

  return {
    ...task,
    payload: {
      ...task.payload,
      harnessModelOverrides: {
        ...(task.payload.harnessModelOverrides ?? {}),
        ...harnessModelOverrides,
      },
    },
  };
}

export function resolveEffectiveHarnessModelState<T extends TaskSpec>(options: {
  task: T;
  targetHarness: CodingHarness;
  isSnapshotResume: boolean;
  sourceJobHarnessModelOverrides?: HarnessModelOverrides;
  deploymentMetadata?: MetadataRecord | null;
  deploymentTaskModelSettings?: TaskModelSettings | null;
  deploymentCodeReviewModelId?: string | null;
}): { task: T; model: string } {
  const shouldReuseSourceHarnessModelOverrides =
    options.isSnapshotResume && Boolean(options.sourceJobHarnessModelOverrides);

  if (shouldReuseSourceHarnessModelOverrides) {
    const nextTask = applyHarnessModelOverrides(
      options.task,
      options.sourceJobHarnessModelOverrides,
    );

    return {
      task: nextTask,
      model: resolveTaskModelForHarness(
        options.targetHarness,
        nextTask.payload.harnessModelOverrides,
      ),
    };
  }

  if (options.task.payload.harnessModelOverrides) {
    const selectedModelId = getHarnessModelOverride(
      options.task.payload.harnessModelOverrides,
      'opencode-server',
    );

    if (
      selectedModelId &&
      !isTaskModelIdAllowed(
        options.deploymentTaskModelSettings,
        selectedModelId,
      )
    ) {
      throw new Error(
        `Model "${selectedModelId}" is not enabled for new tasks.`,
      );
    }

    return {
      task: options.task,
      model: resolveTaskModelForHarness(
        options.targetHarness,
        options.task.payload.harnessModelOverrides,
      ),
    };
  }

  const defaultTaskModelId = getDefaultTaskModelId(
    options.deploymentTaskModelSettings,
  );
  const resolvedCodeReviewModelId = isConfiguredModelId(
    options.deploymentCodeReviewModelId,
  )
    ? options.deploymentCodeReviewModelId
    : null;
  const taskModelId =
    isCodeReviewTaskType(options.task) && resolvedCodeReviewModelId
      ? resolvedCodeReviewModelId
      : defaultTaskModelId;
  const nextTask = applyHarnessModelOverrides(options.task, {
    'opencode-server': taskModelId,
  });

  return {
    task: nextTask,
    model: resolveTaskModelForHarness(
      options.targetHarness,
      nextTask.payload.harnessModelOverrides,
    ),
  };
}
