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
    // Multi-connection providers stay available so operators can add another
    // named instance even after one is connected.
    availableProviders: providers.filter(
      (provider) =>
        provider.allowMultipleConnections ||
        (!provider.runtimeApiKeySatisfied && !provider.savedApiKeySatisfied),
    ),
  };
}
