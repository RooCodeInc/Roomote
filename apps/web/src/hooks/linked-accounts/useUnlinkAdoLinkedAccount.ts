import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkAdoLinkedAccount = createUseUnlinkOAuthLinkedAccount({
  providerId: 'ado',
  providerName: 'Azure DevOps',
  createQueryKey: (trpc) => trpc.linkedAccounts.ado.queryKey(),
});
