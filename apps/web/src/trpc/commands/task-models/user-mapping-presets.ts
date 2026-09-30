import {
  and,
  asc,
  db,
  eq,
  userTaskModelMappingPresets,
} from '@roomote/db/server';
import {
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLE_DISPLAY_NAMES,
  TASK_MODEL_ROLES,
  normalizeTaskModelId,
  userTaskModelMappingPresetCreateSchema,
} from '@roomote/types';
import type {
  TaskModelRole,
  UserTaskModelMapping,
  UserTaskModelMappingPreset,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { getTaskModelSettingsCommand } from './index';

function assertAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function getNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export async function listUserTaskModelMappingPresetsCommand(
  auth: UserAuthSuccess,
): Promise<UserTaskModelMappingPreset[]> {
  assertAdmin(auth);

  return db.query.userTaskModelMappingPresets.findMany({
    where: eq(userTaskModelMappingPresets.userId, auth.userId),
    columns: {
      id: true,
      name: true,
      roles: true,
    },
    orderBy: [asc(userTaskModelMappingPresets.createdAt)],
  });
}

export async function createUserTaskModelMappingPresetCommand(
  auth: UserAuthSuccess,
  input: unknown,
): Promise<UserTaskModelMappingPreset> {
  assertAdmin(auth);

  const parsed = userTaskModelMappingPresetCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid model preset.');
  }

  const { name, roles: inputRoles } = parsed.data;
  if (
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error('Preset names cannot contain control characters.');
  }

  const nameKey = getNameKey(name);
  const existing = await db.query.userTaskModelMappingPresets.findMany({
    where: eq(userTaskModelMappingPresets.userId, auth.userId),
    columns: { id: true, nameKey: true },
  });

  if (existing.some((preset) => preset.nameKey === nameKey)) {
    throw new Error('A custom preset with that name already exists.');
  }

  const settings = await getTaskModelSettingsCommand(auth);
  const availableModelIdsByRole = Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => {
      const availableModelIds =
        role === 'coding'
          ? settings.models
              .filter((model) => model.enabled)
              .map((model) => model.id)
          : settings.helperModelOptions.map((model) => model.id);

      const runtimeModel =
        settings.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];
      if (runtimeModel.managedByEnv && runtimeModel.effectiveModelId) {
        availableModelIds.push(runtimeModel.effectiveModelId);
      }

      return [role, new Set(availableModelIds.map(normalizeTaskModelId))];
    }),
  ) as Record<TaskModelRole, Set<string>>;

  const roles = Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => {
      const selection = inputRoles[role];

      return [
        role,
        {
          modelId: normalizeTaskModelId(selection.modelId),
          reasoningEffort: selection.reasoningEffort,
        },
      ];
    }),
  ) as UserTaskModelMapping;
  const unavailableRoles = TASK_MODEL_ROLES.filter(
    (role) => !availableModelIdsByRole[role].has(roles[role].modelId),
  );

  if (unavailableRoles.length > 0) {
    throw new Error(
      `Choose a currently available model for every role. Unavailable: ${unavailableRoles.map((role) => TASK_MODEL_ROLE_DISPLAY_NAMES[role]).join(', ')}.`,
    );
  }

  const metadataByModelId = new Map(
    settings.models.map((model) => [
      normalizeTaskModelId(model.id),
      model.metadata,
    ]),
  );
  const invalidReasoningRoles = TASK_MODEL_ROLES.filter((role) => {
    const { modelId, reasoningEffort } = roles[role];
    const metadata = metadataByModelId.get(modelId);

    if (reasoningEffort === null || !metadata) {
      return false;
    }

    if (metadata.supportsReasoning === false) {
      return true;
    }

    const supportedEfforts = metadata.supportedReasoningEfforts;
    return Boolean(
      supportedEfforts && !supportedEfforts.includes(reasoningEffort),
    );
  });

  if (invalidReasoningRoles.length > 0) {
    throw new Error(
      `Choose a reasoning level supported by each selected model. Invalid: ${invalidReasoningRoles.map((role) => TASK_MODEL_ROLE_DISPLAY_NAMES[role]).join(', ')}.`,
    );
  }

  try {
    const [preset] = await db
      .insert(userTaskModelMappingPresets)
      .values({
        userId: auth.userId,
        name,
        nameKey,
        roles,
      })
      .returning({
        id: userTaskModelMappingPresets.id,
        name: userTaskModelMappingPresets.name,
        roles: userTaskModelMappingPresets.roles,
      });

    if (!preset) {
      throw new Error('Failed to create the custom model preset.');
    }

    return preset;
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new Error('A custom preset with that name already exists.');
    }

    throw error;
  }
}

export async function deleteUserTaskModelMappingPresetCommand(
  auth: UserAuthSuccess,
  input: { id: string },
): Promise<{ id: string; name: string }> {
  assertAdmin(auth);

  const [preset] = await db
    .delete(userTaskModelMappingPresets)
    .where(
      and(
        eq(userTaskModelMappingPresets.id, input.id),
        eq(userTaskModelMappingPresets.userId, auth.userId),
      ),
    )
    .returning({
      id: userTaskModelMappingPresets.id,
      name: userTaskModelMappingPresets.name,
    });

  if (!preset) {
    throw new Error('Custom model preset not found.');
  }

  return preset;
}
