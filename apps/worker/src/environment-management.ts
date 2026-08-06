import {
  environmentManagementActions,
  isEnvironmentManagementMode,
  resolveEnvironmentManagementMode,
} from '@roomote/types';

export { resolveEnvironmentManagementMode } from '@roomote/types';

const ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE =
  'ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE';

export function buildEnvironmentManagementRuntimeEnv(
  input: Parameters<typeof resolveEnvironmentManagementMode>[0],
): Record<string, string> {
  const mode = resolveEnvironmentManagementMode(input);

  return mode ? { [ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE]: mode } : {};
}

export function applyEnvironmentManagementRuntimeEnv(
  runtimeEnv: Record<string, string>,
  input: Parameters<typeof resolveEnvironmentManagementMode>[0],
): Record<string, string> {
  const trustedRuntimeEnv = { ...runtimeEnv };
  delete trustedRuntimeEnv[ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE];

  return {
    ...trustedRuntimeEnv,
    ...buildEnvironmentManagementRuntimeEnv(input),
  };
}

export function getEnvironmentManagementActions(
  value = process.env[ROOMOTE_ENVIRONMENT_MANAGEMENT_MODE],
) {
  return isEnvironmentManagementMode(value)
    ? environmentManagementActions[value]
    : null;
}
