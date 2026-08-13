import { validateNonTaskInference } from '@roomote/cloud-agents/server';
import { resolveEffectiveDeploymentEnvVars } from '@roomote/db/server';
import { isConfiguredEnvValue } from '@roomote/types';

export class InferenceProviderValidationError extends Error {
  constructor(
    readonly code:
      | 'endpoint_unreachable'
      | 'insufficient_credits'
      | 'invalid_credentials'
      | 'model_unavailable'
      | 'provider_error'
      | 'rate_limited'
      | 'timeout',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InferenceProviderValidationError';
  }
}

/**
 * Validates the effective provider configuration before it is persisted.
 * Runtime env values retain their normal precedence over database values;
 * submitted values replace only credentials that the UI is allowed to own.
 */
export async function assertInferenceProviderConnection(params: {
  clearedEnvVarNames?: string[];
  credentialValues: Array<{ name: string; value: string }>;
  modelId: string;
  providerEnvVarNames: string[];
  providerLabel: string;
}): Promise<void> {
  const persistedEnv = await resolveEffectiveDeploymentEnvVars();
  const clearedEnvVarNames = new Set(params.clearedEnvVarNames ?? []);
  const allowedEnvVarNames = new Set([
    ...params.providerEnvVarNames,
    ...params.credentialValues.map(({ name }) => name),
    'OPENCODE_CONFIG_CONTENT',
    'R_MODEL_ENV_KEYS',
  ]);
  const candidateEnv: Record<string, string> = {};

  for (const [name, value] of Object.entries(persistedEnv)) {
    if (
      allowedEnvVarNames.has(name) &&
      !clearedEnvVarNames.has(name) &&
      !isConfiguredEnvValue(process.env[name])
    ) {
      candidateEnv[name] = value;
    }
  }

  for (const { name, value } of params.credentialValues) {
    if (!isConfiguredEnvValue(process.env[name])) {
      candidateEnv[name] = value;
    }
  }

  const result = await validateNonTaskInference({
    model: params.modelId,
    runtimeEnv: candidateEnv,
  });

  if (!result.success) {
    throw new InferenceProviderValidationError(
      result.reason,
      `${params.providerLabel}: ${result.message}`,
      result.retryable,
    );
  }
}
