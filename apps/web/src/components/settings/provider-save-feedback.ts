import {
  getSetupProviderModelIdPrefixes,
  getTaskModelProviderId,
  type SetupModelProviderDescriptor,
} from '@roomote/types';

/**
 * What to tell the operator after a provider's credentials are saved. A
 * provider whose models are chosen explicitly connects with none enabled, so
 * until one of its models is enabled the save is only half of the job: say so
 * and bring the model list into view.
 */
export function getProviderSaveFeedback(options: {
  provider: SetupModelProviderDescriptor;
  providerLabel: string;
  addedRecommendedModelCount: number;
  addedDiscoveredModelCount: number;
  /** The Available Models list, when it is loaded. */
  models: ReadonlyArray<{ id: string; enabled: boolean }> | undefined;
}): { message: string; showModelList: boolean } {
  const {
    provider,
    providerLabel,
    addedRecommendedModelCount,
    addedDiscoveredModelCount,
    models,
  } = options;

  if (addedDiscoveredModelCount > 0) {
    return {
      message: `Saved the ${providerLabel} API key and made ${addedDiscoveredModelCount} discovered ${addedDiscoveredModelCount === 1 ? 'model' : 'models'} available.`,
      showModelList: true,
    };
  }

  if (addedRecommendedModelCount > 0) {
    return {
      message: `Saved the ${providerLabel} API key and added ${addedRecommendedModelCount} recommended ${addedRecommendedModelCount === 1 ? 'model' : 'models'}.`,
      showModelList: true,
    };
  }

  const providerModelIdPrefixes = getSetupProviderModelIdPrefixes(provider);
  const needsModelChoice =
    provider.requiresModelSelection === true &&
    models !== undefined &&
    !models.some((model) => {
      const prefix = getTaskModelProviderId(model.id);
      return (
        model.enabled && prefix !== null && providerModelIdPrefixes.has(prefix)
      );
    });

  return needsModelChoice
    ? {
        message: `Saved the ${providerLabel} API key. Enable a model below to start using it.`,
        showModelList: true,
      }
    : { message: `Saved the ${providerLabel} API key.`, showModelList: false };
}
