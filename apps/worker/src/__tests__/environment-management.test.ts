import { TaskPayloadKind } from '@roomote/types';

import {
  applyEnvironmentManagementRuntimeEnv,
  buildEnvironmentManagementRuntimeEnv,
  getEnvironmentManagementActions,
  resolveEnvironmentManagementMode,
} from '../environment-management';

describe('environment management capabilities', () => {
  it.each([
    ['create', ['create', 'update', 'record_verification']],
    ['update', ['update', 'record_verification']],
    ['verify', ['record_verification']],
  ] as const)('maps %s capability to its actions', (mode, actions) => {
    expect(getEnvironmentManagementActions(mode)).toEqual(actions);
  });

  it('uses the explicit trusted task capability', () => {
    expect(
      resolveEnvironmentManagementMode({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { environmentManagementMode: 'update' },
        workflow: 'standard',
      }),
    ).toBe('update');
  });

  it('builds the restricted worker runtime environment', () => {
    expect(
      buildEnvironmentManagementRuntimeEnv({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { environmentManagementMode: 'create' },
      }),
    ).toEqual({ ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE: 'create' });
  });

  it('removes an untrusted environment-management override', () => {
    expect(
      applyEnvironmentManagementRuntimeEnv(
        {
          PATH: '/usr/bin',
          ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE: 'create',
        },
        {
          payloadKind: TaskPayloadKind.StandardTask,
          payload: {},
          workflow: 'standard',
        },
      ),
    ).toEqual({ PATH: '/usr/bin' });
  });

  it.each([
    [{ verifiesEnvironmentId: 'env-1' }, 'verify'],
    [{ environmentDefinitionId: 'env-1' }, 'update'],
    [{ projectDefinitionEnvironmentId: 'env-1' }, 'update'],
    [{ repo: 'acme/app' }, 'create'],
  ] as const)(
    'supports an already-queued setup payload',
    (payload, expected) => {
      expect(
        resolveEnvironmentManagementMode({
          payloadKind: TaskPayloadKind.StandardTask,
          payload,
          workflow: 'setup_onboarding',
        }),
      ).toBe(expected);
    },
  );

  it('omits environment management from ordinary tasks', () => {
    expect(
      resolveEnvironmentManagementMode({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { environmentId: 'env-1' },
        workflow: 'standard',
      }),
    ).toBeNull();
  });

  it('does not infer update capability from markers on ordinary tasks', () => {
    expect(
      resolveEnvironmentManagementMode({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { environmentDefinitionId: 'env-1' },
        workflow: 'standard',
      }),
    ).toBeNull();
  });

  it('does not implicitly inherit setup capability on snapshot resume', () => {
    expect(
      resolveEnvironmentManagementMode({
        payloadKind: TaskPayloadKind.SnapshotResume,
        payload: { environmentManagementMode: 'create' },
        workflow: 'setup_onboarding',
      }),
    ).toBeNull();
  });
});
