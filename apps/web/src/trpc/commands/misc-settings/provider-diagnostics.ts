type CommunicationProviderDiagnosticsInput = {
  slackActiveCount: number;
  teamsActiveCount: number;
  telegramMappingCount: number;
  discordActiveCount: number;
  slackRuntimeConfigured: boolean;
  teamsRuntimeConfigured: boolean;
  telegramRuntimeConfigured: boolean;
  discordRuntimeConfigured: boolean;
};

export function buildConfiguredCommunicationProviders(
  input: CommunicationProviderDiagnosticsInput,
): string[] {
  const providers: string[] = [];
  if (input.slackActiveCount > 0 || input.slackRuntimeConfigured) {
    providers.push('slack');
  }
  if (input.teamsActiveCount > 0 || input.teamsRuntimeConfigured) {
    providers.push('teams');
  }
  if (input.telegramMappingCount > 0 || input.telegramRuntimeConfigured) {
    providers.push('telegram');
  }
  if (input.discordActiveCount > 0 || input.discordRuntimeConfigured) {
    providers.push('discord');
  }
  return providers;
}
