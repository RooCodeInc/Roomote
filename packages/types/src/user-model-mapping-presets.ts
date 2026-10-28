import { z } from 'zod';
import { REASONING_EFFORT_VALUES } from './task-runs';

import {
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
  type TaskModelRole,
  type UserTaskModelMapping,
  type UserTaskModelMappingRole,
} from './model-provider-config';

export const USER_TASK_MODEL_MAPPING_PRESET_NAME_MAX_LENGTH = 64;
export const USER_TASK_MODEL_MAPPING_PRESET_MODEL_ID_MAX_LENGTH = 500;

const userTaskModelMappingRoleSchema = z
  .object({
    modelId: z
      .string()
      .trim()
      .min(1)
      .max(USER_TASK_MODEL_MAPPING_PRESET_MODEL_ID_MAX_LENGTH),
    reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable(),
  })
  .strict();

export const userTaskModelMappingSchema = z
  .object(
    Object.fromEntries(
      TASK_MODEL_ROLES.map((role) => [role, userTaskModelMappingRoleSchema]),
    ) as Record<TaskModelRole, typeof userTaskModelMappingRoleSchema>,
  )
  .strict() satisfies z.ZodType<UserTaskModelMapping>;

export const userTaskModelMappingPresetCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a preset name.')
    .max(
      USER_TASK_MODEL_MAPPING_PRESET_NAME_MAX_LENGTH,
      `Preset names must be ${USER_TASK_MODEL_MAPPING_PRESET_NAME_MAX_LENGTH} characters or fewer.`,
    ),
  roles: userTaskModelMappingSchema,
});

export type UserTaskModelMappingPreset = {
  id: string;
  name: string;
  roles: Record<TaskModelRole, UserTaskModelMappingRole | null>;
};

/**
 * Read saved JSON without rewriting it or weakening the create contract.
 * Absent inherited roles follow the saved coding selection. Explicitly invalid
 * entries stay invalid (including on repeated reads), never a different model.
 * Model availability and supported reasoning are checked against the live
 * catalog by consumers, not by this persisted-data reader.
 */
export function readPersistedUserTaskModelMapping(
  value: unknown,
): UserTaskModelMappingPreset['roles'] {
  const stored =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const coding = userTaskModelMappingRoleSchema.safeParse(stored.coding);

  return Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => {
      if (
        !Object.hasOwn(stored, role) &&
        TASK_MODEL_ROLE_DESCRIPTORS[role].modelFallback === 'coding'
      ) {
        return [role, coding.success ? { ...coding.data } : null];
      }

      const parsed = userTaskModelMappingRoleSchema.safeParse(stored[role]);
      return [role, parsed.success ? parsed.data : null];
    }),
  ) as UserTaskModelMappingPreset['roles'];
}
