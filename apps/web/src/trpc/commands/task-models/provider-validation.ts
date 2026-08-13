import type { NonTaskInferenceValidationFailureReason } from '@roomote/cloud-agents/server';
import { validateNonTaskInference } from '@roomote/cloud-agents/server';
import { resolveEffectiveDeploymentEnvVars } from '@roomote/db/server';
import {
  collectSetupModelProviderCredentialValues,
  getSetupModelProviderEnvVarNames,
  isConfiguredEnvValue,
} from '@roomote/types';

export class InferenceProviderValidationError extends Error {
  constructor(
    readonly code: NonTaskInferenceValidationFailureReason,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InferenceProviderValidationError';
  }
}

// Only failures that squarely indict the submitted credentials may block a
// save. Model access, rate limits, and unreachable endpoints also arise from
// catalog defaults the account legitimately lacks (Azure models are
// customer-named deployments) or from Roomote's own validation helper, and
// must not lock an operator out of connecting a working provider.
const BLOCKING_FAILURE_REASONS =
  new Set<NonTaskInferenceValidationFailureReason>([
    'insufficient_credits',
    'invalid_credentials',
  ]);

type CollectCredentialParams = Parameters<
  typeof collectSetupModelProviderCredentialValues
>[0];

/**
 * Resolves the persisted deployment env once and collects the candidate
 * credential values a save would persist for the provider.
 */
async function collectCandidateProviderCredentials(
  params: Omit<CollectCredentialParams, 'isEnvVarSatisfied'>,
): Promise<
  ReturnType<typeof collectSetupModelProviderCredentialValues> & {
    persistedEnv: Record<string, string>;
  }
> {
  const persistedEnv = await resolveEffectiveDeploymentEnvVars();
  const persistedEnvVarNameSet = new Set(Object.keys(persistedEnv));

  return {
    ...collectSetupModelProviderCredentialValues({
      ...params,
      isEnvVarSatisfied: (envVarName) =>
        persistedEnvVarNameSet.has(envVarName) ||
        isConfiguredEnvValue(process.env[envVarName]),
    }),
    persistedEnv,
  };
}

/**
 * Validates the effective provider configuration before it is persisted.
 * Persisted values the runtime env does not override fill in surrounding
 * context (regions, base URLs); submitted values are always the values
 * exercised, because they are exactly what the save will persist.
 */
export async function assertInferenceProviderConnection(params: {
  clearedEnvVarNames?: string[];
  credentialValues: Array<{ name: string; value: string }>;
  modelId: string;
  persistedEnv?: Record<string, string>;
  providerEnvVarNames: string[];
  providerLabel: string;
}): Promise<void> {
  const persistedEnv =
    params.persistedEnv ?? (await resolveEffectiveDeploymentEnvVars());
  const clearedEnvVarNames = new Set(params.clearedEnvVarNames ?? []);
  const allowedEnvVarNames = new Set([
    ...params.providerEnvVarNames,
    ...params.credentialValues.map(({ name }) => name),
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

  // A runtime env var shadowing a submitted value must not exempt it from
  // validation: another service resolving the persisted value would receive
  // a credential that was never tested.
  for (const { name, value } of params.credentialValues) {
    candidateEnv[name] = value;
  }

  const result = await validateNonTaskInference({
    model: params.modelId,
    runtimeEnv: candidateEnv,
  });

  if (!result.success && BLOCKING_FAILURE_REASONS.has(result.reason)) {
    throw new InferenceProviderValidationError(
      result.reason,
      `${params.providerLabel}: ${result.message}`,
      result.retryable,
    );
  }
}

/**
 * Pre-save credential validation shared by the setup wizard and the Models
 * settings page: collect the candidate credentials once, skip the live check
 * when the save changes nothing, and qualify the rest through the non-task
 * inference canary.
 */
export async function validateSetupModelProviderCredentials(
  params: Omit<CollectCredentialParams, 'isEnvVarSatisfied'> & {
    modelId: string;
  },
): Promise<void> {
  const { modelId, ...collectParams } = params;
  const { values, clearedEnvVarNames, persistedEnv } =
    await collectCandidateProviderCredentials(collectParams);

  // An unchanged save must not depend on the provider being reachable right
  // now; only submitted or cleared values need qualification.
  if (values.length === 0 && clearedEnvVarNames.length === 0) {
    return;
  }

  await assertInferenceProviderConnection({
    providerLabel: params.provider.label,
    providerEnvVarNames: getSetupModelProviderEnvVarNames(params.provider),
    modelId,
    credentialValues: values,
    clearedEnvVarNames,
    persistedEnv,
  });
}
