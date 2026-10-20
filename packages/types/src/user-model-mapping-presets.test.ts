import {
  TASK_MODEL_ROLES,
  TASK_MODEL_ROLE_DESCRIPTORS,
} from './model-provider-config';
import {
  readPersistedUserTaskModelMapping,
  userTaskModelMappingPresetCreateSchema,
} from './user-model-mapping-presets';

const coding = {
  modelId: 'openrouter/openai/gpt-5.4',
  reasoningEffort: 'high',
};
const legacy = Object.fromEntries(
  TASK_MODEL_ROLES.filter((role) => role !== 'audioVideo').map((role) => [
    role,
    { ...coding, reasoningEffort: role === 'helper' ? null : 'high' },
  ]),
);

describe('persisted user model mapping compatibility', () => {
  it('adapts the v1.15.1 shape without changing any saved selection or the input', () => {
    const original = structuredClone(legacy);
    const read = readPersistedUserTaskModelMapping(legacy);
    expect(read).toEqual({ ...legacy, audioVideo: coding });
    expect(legacy).toEqual(original);
    expect(readPersistedUserTaskModelMapping(read)).toEqual(read);
    expect(
      userTaskModelMappingPresetCreateSchema.safeParse({
        name: 'Old',
        roles: legacy,
      }).success,
    ).toBe(false);
    expect(
      userTaskModelMappingPresetCreateSchema.safeParse({
        name: 'New',
        roles: read,
      }).success,
    ).toBe(true);
  });

  it('derives missing role inheritance from the shared descriptors', () => {
    const read = readPersistedUserTaskModelMapping({ coding });
    for (const role of TASK_MODEL_ROLES) {
      if (TASK_MODEL_ROLE_DESCRIPTORS[role].modelFallback === 'coding') {
        expect(read[role]).toEqual(coding);
        expect(read[role]).not.toBe(read.coding);
      }
    }
  });

  it.each([null, [], 'bad', 12])(
    'handles malformed top-level JSON %j',
    (value) => {
      expect(Object.values(readPersistedUserTaskModelMapping(value))).toEqual(
        TASK_MODEL_ROLES.map(() => null),
      );
    },
  );

  it.each([
    null,
    'bad',
    {},
    { modelId: 12, reasoningEffort: null },
    { modelId: ' ', reasoningEffort: null },
    { modelId: coding.modelId, reasoningEffort: 'invalid' },
  ])('does not inherit over explicit malformed entries %j', (audioVideo) => {
    const read = readPersistedUserTaskModelMapping({ ...legacy, audioVideo });
    expect(read.audioVideo).toBeNull();
    expect(read.coding).toEqual(coding);
    expect(readPersistedUserTaskModelMapping(read)).toEqual(read);
  });

  it('does not invent a coding model or replace unknown model IDs', () => {
    expect(
      readPersistedUserTaskModelMapping({ helper: coding }).coding,
    ).toBeNull();
    expect(
      readPersistedUserTaskModelMapping({ helper: coding }).audioVideo,
    ).toBeNull();
    const unknown = {
      modelId: 'removed-provider/old-model',
      reasoningEffort: 'max',
    };
    expect(
      readPersistedUserTaskModelMapping({ coding: unknown }).audioVideo,
    ).toEqual(unknown);
  });
});
