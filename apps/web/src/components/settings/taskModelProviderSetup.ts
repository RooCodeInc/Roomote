import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  type SetupModelProviderStatus,
  type SetupModelStatus,
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
    // Only the OpenAI-compatible catalog template stays addable while
    // connected, so operators can create another named instance. Named
    // connected rows themselves stay out of the Add Provider list.
    availableProviders: providers.filter((provider) => {
      if (provider.hidden) {
        return false;
      }

      const isConnected =
        provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied;

      if (!isConnected) {
        return true;
      }

      return (
        provider.allowMultipleConnections === true &&
        provider.id === OPENAI_COMPATIBLE_PROVIDER_ID
      );
    }),
  };
}
