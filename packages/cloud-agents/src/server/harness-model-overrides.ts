import {
  type TaskSpec,
  type CodingHarness,
  type HarnessModelOverrides,
  type ReasoningEffort,
  type TaskModelSettings,
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  TaskPayloadKind,
  getDefaultTaskModelId,
  getHarnessModelOverride,
  getTaskModelCatalog,
  isTaskModelIdAllowed,
} from '@roomote/types';

import { DEFAULT_STANDARD_TASK_MODEL } from '../task-runtime-defaults';

function isConfiguredModelId(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCodeReviewTaskType(taskType: TaskPayloadKind): boolean {
  return (
    taskType === TaskPayloadKind.GithubPrReview ||
    taskType === TaskPayloadKind.GithubPrReviewSync
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

/**
 * Resolves the reasoning effort a launch-time model override should run
 * with. Overrides do not match the worker's per-role reasoning env vars
 * (those are scoped to the models each role was configured with), so
 * without this the override would run with no reasoning configured at all.
 * Inherits the deployment's coding-role level, falling back to the coding
 * default; models whose catalog metadata reports no configurable reasoning
 * get none (unknown support keeps the default, matching the runtime-env
 * resolution).
 */
function resolveOverrideTaskReasoningEffort(options: {
  modelId: string;
  deploymentTaskModelSettings?: TaskModelSettings | null;
  deploymentCodeReviewReasoningEffort?: ReasoningEffort | null;
  deploymentCodingReasoningEffort?: ReasoningEffort | null;
  isCodeReviewTask: boolean;
}): ReasoningEffort | null {
  const catalogModel = getTaskModelCatalog(
    options.deploymentTaskModelSettings,
  ).find((model) => model.id === options.modelId);

  if (catalogModel?.metadata?.supportsReasoning === false) {
    return null;
  }

  return options.isCodeReviewTask
    ? (options.deploymentCodeReviewReasoningEffort ??
        DEFAULT_MODEL_ROLE_REASONING_EFFORTS.codeReview)
    : (options.deploymentCodingReasoningEffort ??
        DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding);
}

/**
 * Stamps `payload.reasoningEffort` for a launch that selected a model
 * override, so the worker can apply a reasoning level to the override
 * model. Explicit per-task efforts (for example from the public launch
 * API) always win.
 */
function applyOverrideTaskReasoningEffort<T extends TaskSpec>(
  task: T,
  options: {
    targetHarness: CodingHarness;
    deploymentTaskModelSettings?: TaskModelSettings | null;
    deploymentCodeReviewReasoningEffort?: ReasoningEffort | null;
    deploymentCodingReasoningEffort?: ReasoningEffort | null;
    isCodeReviewTask: boolean;
  },
): T {
  if (options.targetHarness !== 'opencode-server') {
    return task;
  }

  if (task.payload.reasoningEffort) {
    return task;
  }

  const overrideModelId = getHarnessModelOverride(
    task.payload.harnessModelOverrides,
    'opencode-server',
  );

  if (!overrideModelId) {
    return task;
  }

  const reasoningEffort = resolveOverrideTaskReasoningEffort({
    modelId: overrideModelId,
    deploymentTaskModelSettings: options.deploymentTaskModelSettings,
    deploymentCodeReviewReasoningEffort:
      options.deploymentCodeReviewReasoningEffort,
    deploymentCodingReasoningEffort: options.deploymentCodingReasoningEffort,
    isCodeReviewTask: options.isCodeReviewTask,
  });

  if (!reasoningEffort) {
    return task;
  }

  return {
    ...task,
    payload: {
      ...task.payload,
      reasoningEffort,
    },
  };
}

export function resolveEffectiveHarnessModelState<T extends TaskSpec>(options: {
  task: T;
  targetHarness: CodingHarness;
  isSnapshotResume: boolean;
  sourceRunHarnessModelOverrides?: HarnessModelOverrides;
  sourceTaskType?: TaskPayloadKind;
  deploymentTaskModelSettings?: TaskModelSettings | null;
  deploymentCodeReviewModelId?: string | null;
  deploymentCodeReviewReasoningEffort?: ReasoningEffort | null;
  deploymentCodingReasoningEffort?: ReasoningEffort | null;
}): { task: T; model: string } {
  const shouldReuseSourceHarnessModelOverrides =
    options.isSnapshotResume && Boolean(options.sourceRunHarnessModelOverrides);

  if (shouldReuseSourceHarnessModelOverrides) {
    const nextTask = applyOverrideTaskReasoningEffort(
      applyHarnessModelOverrides(
        options.task,
        options.sourceRunHarnessModelOverrides,
      ),
      {
        ...options,
        isCodeReviewTask: isCodeReviewTaskType(
          options.sourceTaskType ?? options.task.type,
        ),
      },
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
      task: applyOverrideTaskReasoningEffort(options.task, {
        ...options,
        isCodeReviewTask: isCodeReviewTaskType(options.task.type),
      }),
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
    isCodeReviewTaskType(options.task.type) && resolvedCodeReviewModelId
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
