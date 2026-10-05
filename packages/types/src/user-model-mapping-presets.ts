import { z } from 'zod';
import { REASONING_EFFORT_VALUES } from './task-runs';

import {
  TASK_MODEL_ROLES,
  type TaskModelRole,
  type UserTaskModelMapping,
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
  roles: UserTaskModelMapping;
};
