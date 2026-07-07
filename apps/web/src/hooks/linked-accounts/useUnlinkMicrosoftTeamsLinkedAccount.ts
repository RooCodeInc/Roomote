import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkMicrosoftTeamsLinkedAccount =
  createUseUnlinkOAuthLinkedAccount({
    providerId: 'microsoft-entra-id',
    providerName: 'Microsoft Teams',
    createQueryKey: (trpc) => trpc.linkedAccounts.microsoftTeams.queryKey(),
  });
