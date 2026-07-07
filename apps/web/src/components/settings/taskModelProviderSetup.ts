import type {
  SetupModelProviderStatus,
  SetupModelStatus,
} from '@roomote/types';

export function splitInferenceProviders(
  providerSetup: SetupModelStatus | null,
): {
  connectedProviders: SetupModelProviderStatus[];
  availableProviders: SetupModelProviderStatus[];
} {
  const providers = providerSetup?.providers ?? [];

  return {
    connectedProviders: providers.filter(
      (provider) =>
        provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
    ),
    availableProviders: providers.filter(
      (provider) =>
        !provider.runtimeApiKeySatisfied && !provider.savedApiKeySatisfied,
    ),
  };
}
