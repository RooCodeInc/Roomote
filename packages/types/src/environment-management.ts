import { getEnvironmentDefinitionIdFromPayload } from './environment-definition-tasks';

export const environmentManagementModes = [
  'create',
  'update',
  'verify',
] as const;

export type EnvironmentManagementMode =
  (typeof environmentManagementModes)[number];

export type EnvironmentManagementAction =
  | 'create'
  | 'update'
  | 'record_verification';

export const environmentManagementActions = {
  // Creation tasks may need to revise the new definition after their spawned
  // verification task reports a fixable setup problem.
  create: ['create', 'update', 'record_verification'],
  update: ['update', 'record_verification'],
  verify: ['record_verification'],
} as const satisfies Record<
  EnvironmentManagementMode,
  readonly EnvironmentManagementAction[]
>;

export function isEnvironmentManagementMode(
  value: unknown,
): value is EnvironmentManagementMode {
  return environmentManagementModes.includes(
    value as EnvironmentManagementMode,
  );
}

export function resolveEnvironmentManagementMode(input: {
  payloadKind: string;
  payload: unknown;
  workflow?: string;
}): EnvironmentManagementMode | null {
  if (
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    return null;
  }

  const payload = input.payload as Record<string, unknown>;

  if (input.payloadKind === 'snapshot_resume') {
    return null;
  }

  if (isEnvironmentManagementMode(payload.environmentManagementMode)) {
    return payload.environmentManagementMode;
  }

  if (typeof payload.verifiesEnvironmentId === 'string') {
    return 'verify';
  }

  if (
    input.workflow === 'setup_onboarding' &&
    getEnvironmentDefinitionIdFromPayload(payload)
  ) {
    return 'update';
  }

  if (input.workflow === 'setup_onboarding' && payload.environmentId == null) {
    return 'create';
  }

  return null;
}

export function canPerformEnvironmentManagementAction(
  mode: EnvironmentManagementMode | null,
  action: EnvironmentManagementAction,
): boolean {
  return mode
    ? environmentManagementActions[mode].some(
        (allowedAction) => allowedAction === action,
      )
    : false;
}
