import { createTelegramCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

export async function refreshTelegramCommandMenuAtBoot(): Promise<void> {
  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();
  await provider?.registerCommands();
}
