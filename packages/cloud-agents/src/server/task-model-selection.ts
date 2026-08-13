import {
  db,
  deploymentSettings,
  eq,
  isChatGptSubscriptionConnected,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  TASK_MODEL_OVERRIDE_ROLES,
  getDefaultTaskModelId,
  getDisplayModelProviderId,
  getTaskModelCatalog,
  isReasoningEffort,
  isTaskModelIdAllowed,
  normalizeDeploymentModelConfig,
  normalizeTaskModelSettings,
  resolveTaskModelIdAlias,
  type ReasoningEffort,
  type TaskModelOverrideRole,
  type TaskModelRoleOverrides,
} from '@roomote/types';

const DEFAULT_DEPLOYMENT_ID = 'default';
const MODEL_ID_PATTERN = /^[^/\s]+\/.+$/u;

export type TaskModelSelectionRole = 'coding' | TaskModelOverrideRole;

export const TASK_MODEL_SELECTION_ROLES: readonly TaskModelSelectionRole[] = [
  'coding',
  ...TASK_MODEL_OVERRIDE_ROLES,
];

export class TaskModelSelectionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_model'
      | 'model_not_allowed'
      | 'run_not_found'
      | 'payload_missing',
  ) {
    super(message);
    this.name = 'TaskModelSelectionError';
  }
}

/**
 * Validates and persists one model-role selection for a task run. Shared by
 * the web task UI and the agent-facing platform API so both surfaces apply
 * identical rules:
 *
 * - The coding role writes `payload.harnessModelOverrides` +
 *   `payload.reasoningEffort` (the pair launch/resume/display already use)
 *   and re-stamps `tasks.model` / `tasks.modelProvider` for display.
 * - Other roles write sparse `payload.modelRoleOverrides` entries; a fully
 *   cleared role falls back to the deployment role config.
 *
 * `model` / `reasoningEffort` carry the desired state; null means the
 * deployment default. Persisting does NOT touch the live sandbox — callers
 * follow up with the sandbox `applyTaskModelSettings` procedure when a live
 * apply is wanted.
 */
export async function applyTaskModelSelectionToRun(options: {
  runId: number;
  role: TaskModelSelectionRole;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}): Promise<{ stampedTaskModel: string | null }> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      taskModelSettings: true,
      runtimeModelConfig: true,
    },
  });
  const modelSettings = normalizeTaskModelSettings(
    deployment?.taskModelSettings,
  );
  const runtimeModelConfig = normalizeDeploymentModelConfig(
    deployment?.runtimeModelConfig,
  );
  const trimmedModel = options.model?.trim() || null;

  if (trimmedModel && !MODEL_ID_PATTERN.test(trimmedModel)) {
    throw new TaskModelSelectionError(
      `Model "${trimmedModel}" must use provider/model format.`,
      'invalid_model',
    );
  }

  const requestedModelId = trimmedModel
    ? resolveTaskModelIdAlias(trimmedModel)
    : null;

  if (
    requestedModelId &&
    !isTaskModelIdAllowed(modelSettings, requestedModelId)
  ) {
    throw new TaskModelSelectionError(
      `Model "${requestedModelId}" is not enabled for tasks.`,
      'model_not_allowed',
    );
  }

  return await db.transaction(async (tx) => {
    // Lock the run row for the read-modify-write below: concurrent role
    // updates (the UI's reset fan-out, or the web mutation racing the
    // agent's update_models call) would otherwise each derive the next
    // payload from the same snapshot and silently drop each other's writes.
    const [run] = await tx
      .select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        payload: taskRuns.payload,
      })
      .from(taskRuns)
      .where(eq(taskRuns.id, options.runId))
      .for('update');

    if (!run) {
      throw new TaskModelSelectionError(
        `Task run ${options.runId} not found.`,
        'run_not_found',
      );
    }

    if (!run.payload || typeof run.payload !== 'object') {
      throw new TaskModelSelectionError(
        'The task run has no payload to update.',
        'payload_missing',
      );
    }

    const payload = { ...run.payload };
    let stampedTaskModel: string | null = null;

    if (options.role === 'coding') {
      const effectiveModel =
        requestedModelId ?? getDefaultTaskModelId(modelSettings);
      const catalogModel = getTaskModelCatalog(modelSettings).find(
        (model) => model.id === effectiveModel,
      );
      const supportsReasoning =
        catalogModel?.metadata?.supportsReasoning !== false;

      payload.harnessModelOverrides = {
        ...(payload.harnessModelOverrides ?? {}),
        'opencode-server': effectiveModel,
      };

      if (options.reasoningEffort && supportsReasoning) {
        payload.reasoningEffort = options.reasoningEffort;
      } else if (requestedModelId && supportsReasoning) {
        // Mirror launch-time stamping: an explicitly selected model runs at
        // the deployment coding level (env wins over the persisted config)
        // instead of falling through to no reasoning when the role env level
        // does not match the override model.
        const envCodingEffort = process.env.R_MODEL_REASONING_EFFORT?.trim();

        payload.reasoningEffort =
          (isReasoningEffort(envCodingEffort)
            ? envCodingEffort
            : runtimeModelConfig.roomoteModelReasoningEffort) ??
          DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding;
      } else {
        delete payload.reasoningEffort;
      }

      stampedTaskModel = effectiveModel;
    } else {
      const overrides: TaskModelRoleOverrides = {
        ...(payload.modelRoleOverrides ?? {}),
      };
      const entry = {
        ...(requestedModelId ? { model: requestedModelId } : {}),
        ...(options.reasoningEffort
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
      };

      if (Object.keys(entry).length > 0) {
        overrides[options.role] = entry;
      } else {
        delete overrides[options.role];
      }

      if (Object.keys(overrides).length > 0) {
        payload.modelRoleOverrides = overrides;
      } else {
        delete payload.modelRoleOverrides;
      }
    }

    await tx.update(taskRuns).set({ payload }).where(eq(taskRuns.id, run.id));

    if (stampedTaskModel && run.taskId) {
      const chatgptConnected = stampedTaskModel.startsWith('openai/')
        ? await isChatGptSubscriptionConnected(tx)
        : false;

      await tx
        .update(tasks)
        .set({
          model: stampedTaskModel,
          modelProvider:
            getDisplayModelProviderId(stampedTaskModel, { chatgptConnected }) ??
            'opencode',
        })
        .where(eq(tasks.id, run.taskId));
    }

    return { stampedTaskModel };
  });
}
