import {
  db,
  eq,
  userFactory,
  userTaskModelMappingPresets,
} from '@roomote/db/server';
import {
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
} from '@roomote/types';
import type {
  ReasoningEffort,
  TaskModelRole,
  UserTaskModelMapping,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';

const { mockGetTaskModelSettings } = vi.hoisted(() => ({
  mockGetTaskModelSettings: vi.fn(),
}));

vi.mock('./index', () => ({
  getTaskModelSettingsCommand: mockGetTaskModelSettings,
}));

import {
  createUserTaskModelMappingPresetCommand,
  deleteUserTaskModelMappingPresetCommand,
  listUserTaskModelMappingPresetsCommand,
} from './user-mapping-presets';

const CODING_MODEL_ID = 'openrouter/openai/gpt-5.4';
const HELPER_MODEL_ID = 'openrouter/z-ai/glm-5.2';
const DISABLED_CODING_MODEL_ID = 'openrouter/anthropic/claude-haiku-4-5';

function buildRoles(
  modelOverrides: Partial<Record<TaskModelRole, string>> = {},
  reasoningOverrides: Partial<
    Record<TaskModelRole, ReasoningEffort | null>
  > = {},
): UserTaskModelMapping {
  return Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => [
      role,
      {
        modelId: modelOverrides[role] ?? CODING_MODEL_ID,
        reasoningEffort: Object.hasOwn(reasoningOverrides, role)
          ? reasoningOverrides[role]!
          : DEFAULT_MODEL_ROLE_REASONING_EFFORTS[role],
      },
    ]),
  ) as UserTaskModelMapping;
}

function buildSettingsData() {
  return {
    models: [
      { id: CODING_MODEL_ID, enabled: true },
      { id: HELPER_MODEL_ID, enabled: true },
      { id: DISABLED_CODING_MODEL_ID, enabled: false },
    ],
    helperModelOptions: [
      { id: CODING_MODEL_ID },
      { id: HELPER_MODEL_ID },
      { id: DISABLED_CODING_MODEL_ID },
    ],
    runtimeModels: Object.fromEntries(
      TASK_MODEL_ROLES.map((role) => [
        TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey,
        {
          effectiveModelId: CODING_MODEL_ID,
          managedByEnv: false,
        },
      ]),
    ),
  };
}

function buildAuth(userId: string): UserAuthSuccess {
  return { userId, isAdmin: true } as UserAuthSuccess;
}

describe('user task model mapping presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskModelSettings.mockResolvedValue(buildSettingsData());
  });

  it('persists presets per owner and deletes only the owner’s preset', async () => {
    const [owner, otherUser] = await Promise.all([
      userFactory.create(),
      userFactory.create(),
    ]);
    const roles = buildRoles({ helper: HELPER_MODEL_ID });

    const preset = await createUserTaskModelMappingPresetCommand(
      buildAuth(owner.id),
      { name: '  Balanced blend  ', roles },
    );

    expect(preset).toMatchObject({ name: 'Balanced blend', roles });
    await expect(
      listUserTaskModelMappingPresetsCommand(buildAuth(owner.id)),
    ).resolves.toEqual([preset]);
    await expect(
      listUserTaskModelMappingPresetsCommand(buildAuth(otherUser.id)),
    ).resolves.toEqual([]);

    await expect(
      deleteUserTaskModelMappingPresetCommand(buildAuth(otherUser.id), {
        id: preset.id,
      }),
    ).rejects.toThrow('Custom model preset not found.');
    await expect(
      listUserTaskModelMappingPresetsCommand(buildAuth(owner.id)),
    ).resolves.toEqual([preset]);

    await expect(
      deleteUserTaskModelMappingPresetCommand(buildAuth(owner.id), {
        id: preset.id,
      }),
    ).resolves.toEqual({ id: preset.id, name: 'Balanced blend' });
    await expect(
      listUserTaskModelMappingPresetsCommand(buildAuth(owner.id)),
    ).resolves.toEqual([]);
  });

  it('rejects duplicate names regardless of case and surrounding whitespace', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);

    await createUserTaskModelMappingPresetCommand(auth, {
      name: 'Review heavy',
      roles: buildRoles(),
    });

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: '  REVIEW HEAVY ',
        roles: buildRoles(),
      }),
    ).rejects.toThrow('A custom preset with that name already exists.');
  });

  it('validates every model against its role’s current selectable models', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'Unavailable coding',
        roles: buildRoles({ coding: 'openrouter/old-model' }),
      }),
    ).rejects.toThrow('Unavailable: coding');

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'Disabled coding',
        roles: buildRoles({ coding: DISABLED_CODING_MODEL_ID }),
      }),
    ).rejects.toThrow('Unavailable: coding');

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'Disabled helper',
        roles: buildRoles({ helper: DISABLED_CODING_MODEL_ID }),
      }),
    ).resolves.toMatchObject({
      name: 'Disabled helper',
      roles: { helper: { modelId: DISABLED_CODING_MODEL_ID } },
    });
  });

  it('rejects reasoning levels that the selected model does not support', async () => {
    const settings = buildSettingsData();
    mockGetTaskModelSettings.mockResolvedValue({
      ...settings,
      models: settings.models.map((model) =>
        model.id === CODING_MODEL_ID
          ? {
              ...model,
              metadata: {
                contextWindow: null,
                inputTypes: null,
                inputPricePerToken: null,
                outputPricePerToken: null,
                lastRefreshedAt: null,
                supportedReasoningEfforts: ['low'],
              },
            }
          : model,
      ),
    });
    const user = await userFactory.create();

    await expect(
      createUserTaskModelMappingPresetCommand(buildAuth(user.id), {
        name: 'Unsupported reasoning',
        roles: buildRoles(
          {},
          {
            coding: 'high',
            codeReview: 'low',
            planning: 'low',
          },
        ),
      }),
    ).rejects.toThrow('Invalid: coding');
  });

  it('uses the Advisor label for the legacy planning role in validation errors', async () => {
    const settings = buildSettingsData();
    mockGetTaskModelSettings.mockResolvedValue({
      ...settings,
      models: settings.models.map((model) =>
        model.id === CODING_MODEL_ID
          ? {
              ...model,
              metadata: {
                supportsReasoning: true,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              },
            }
          : model.id === HELPER_MODEL_ID
            ? {
                ...model,
                metadata: {
                  supportsReasoning: true,
                  supportedReasoningEfforts: ['low'],
                },
              }
            : model,
      ),
    });
    const user = await userFactory.create();

    await expect(
      createUserTaskModelMappingPresetCommand(buildAuth(user.id), {
        name: 'Advisor validation',
        roles: buildRoles({ planning: HELPER_MODEL_ID }, { planning: 'high' }),
      }),
    ).rejects.toThrow(
      'Choose a reasoning level supported by each selected model. Invalid: advisor.',
    );
  });

  it('validates preset names and the complete role mapping on the server', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: '   ',
        roles: buildRoles(),
      }),
    ).rejects.toThrow('Enter a preset name.');

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'Missing role',
        roles: { coding: CODING_MODEL_ID },
      }),
    ).rejects.toThrow();
  });

  it('rejects overlong and control-character preset names', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'x'.repeat(65),
        roles: buildRoles(),
      }),
    ).rejects.toThrow('Preset names must be 64 characters or fewer.');

    await expect(
      createUserTaskModelMappingPresetCommand(auth, {
        name: 'Review\nmode',
        roles: buildRoles(),
      }),
    ).rejects.toThrow('Preset names cannot contain control characters.');
  });

  it('rejects non-admin access to private mapping presets', async () => {
    const user = await userFactory.create();

    await expect(
      listUserTaskModelMappingPresetsCommand({
        ...buildAuth(user.id),
        isAdmin: false,
      } as UserAuthSuccess),
    ).rejects.toThrow('Unauthorized');
  });

  it('stores one normalized owner/name key so database uniqueness is enforced', async () => {
    const user = await userFactory.create();
    const preset = await createUserTaskModelMappingPresetCommand(
      buildAuth(user.id),
      { name: 'Tiny model map', roles: buildRoles() },
    );
    const stored = await db.query.userTaskModelMappingPresets.findFirst({
      where: eq(userTaskModelMappingPresets.id, preset.id),
      columns: { userId: true, nameKey: true, roles: true },
    });

    expect(stored).toEqual({
      userId: user.id,
      nameKey: 'tiny model map',
      roles: buildRoles(),
    });
  });
});
