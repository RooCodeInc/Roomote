import { z } from 'zod';
import {
  REASONING_EFFORT_VALUES,
  TASK_MODEL_OVERRIDE_ROLES,
  taskModelRoleOverridesSchema,
  type ConfiguredModelSelection,
  type ReasoningEffort,
  type TaskModelOverrideRole,
} from '@roomote/types';

/** Stored choices only: null means inheritance, not a resolved runtime model. */
export function configuredModelSelection(
  model: string | null | undefined,
  reasoningEffort: ReasoningEffort | null | undefined,
): ConfiguredModelSelection {
  return {
    model: model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    modelSource: model ? 'explicit' : 'default',
    reasoningEffortSource: reasoningEffort ? 'explicit' : 'default',
  };
}

const configuredTaskPayloadSchema = z.object({
  harnessModelOverrides: z
    .object({ 'opencode-server': z.string().optional() })
    .optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  modelRoleOverrides: taskModelRoleOverridesSchema.optional(),
});

export function configuredTaskModels(
  payload: unknown,
): Partial<Record<'coding' | TaskModelOverrideRole, ConfiguredModelSelection>> {
  const parsed = configuredTaskPayloadSchema.safeParse(payload);
  const choices = parsed.success ? parsed.data : undefined;
  const models: Partial<
    Record<'coding' | TaskModelOverrideRole, ConfiguredModelSelection>
  > = {
    coding: configuredModelSelection(
      choices?.harnessModelOverrides?.['opencode-server'],
      choices?.reasoningEffort,
    ),
  };
  for (const role of TASK_MODEL_OVERRIDE_ROLES) {
    const override = choices?.modelRoleOverrides?.[role];
    if (override)
      models[role] = configuredModelSelection(
        override.model,
        override.reasoningEffort,
      );
  }
  return models;
}
