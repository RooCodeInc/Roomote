import {
  db,
  deploymentSettings,
  environmentVariables,
  eq,
  isChatGptSubscriptionConnected,
  isGitHubCopilotSubscriptionConnected,
  isXaiSubscriptionConnected,
} from '@roomote/db/server';
import {
  buildRecommendedDeploymentModelConfig,
  buildSetupModelStatus,
  DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
  getSetupModelProvider,
  normalizeDeploymentModelConfig,
} from '@roomote/types';

const DEV_LOGIN_PROVIDER_ID = 'openrouter';
const DEV_LOGIN_PROVIDER_ENV_VAR_NAME = 'OPENROUTER_API_KEY';

/**
 * Give local dev-login a complete setup state without inventing a usable
 * credential. Existing provider credentials or model choices always win.
 */
export async function ensureDevLoginInferenceSetup(userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .insert(deploymentSettings)
      .values({ id: 'default' })
      .onConflictDoNothing();
    await tx
      .select({ id: deploymentSettings.id })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .for('update');

    const [
      settings,
      persistedEnvVars,
      chatgptConnected,
      githubCopilotConnected,
      xaiSubscriptionConnected,
    ] = await Promise.all([
      tx.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { runtimeModelConfig: true },
      }),
      tx.select({ name: environmentVariables.name }).from(environmentVariables),
      isChatGptSubscriptionConnected(tx),
      isGitHubCopilotSubscriptionConnected(tx),
      isXaiSubscriptionConnected(tx),
    ]);
    const runtimeModelConfig = normalizeDeploymentModelConfig(
      settings?.runtimeModelConfig,
    );
    const hasModelChoice = Object.values(runtimeModelConfig).some(
      (value) => value !== null,
    );
    const modelStatus = buildSetupModelStatus({
      runtimeEnv: process.env,
      persistedModelConfig: runtimeModelConfig,
      persistedEnvVarNames: persistedEnvVars.map(({ name }) => name),
      chatgptConnected,
      githubCopilotConnected,
      xaiSubscriptionConnected,
    });
    const hasConfiguredProvider = modelStatus.providers.some(
      (provider) =>
        provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
    );

    if (hasModelChoice || hasConfiguredProvider) {
      return;
    }

    const inserted = await tx
      .insert(environmentVariables)
      .values({
        userId: null,
        name: DEV_LOGIN_PROVIDER_ENV_VAR_NAME,
        value: DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
        createdByUserId: userId,
        lastUpdatedByUserId: userId,
      })
      .onConflictDoNothing({ target: environmentVariables.name })
      .returning({ id: environmentVariables.id });

    // A concurrent provider save won the unique-key race. Never pair its
    // credential with model settings chosen by this development-only path.
    if (inserted.length === 0) {
      return;
    }

    await tx
      .update(deploymentSettings)
      .set({
        runtimeModelConfig: buildRecommendedDeploymentModelConfig(
          getSetupModelProvider(DEV_LOGIN_PROVIDER_ID),
        ),
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
  });
}
