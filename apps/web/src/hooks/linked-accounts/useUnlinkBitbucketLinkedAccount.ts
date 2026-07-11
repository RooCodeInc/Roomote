import { createUseUnlinkOAuthLinkedAccount } from './shared';

export const useUnlinkBitbucketLinkedAccount =
  createUseUnlinkOAuthLinkedAccount({
    providerId: 'bitbucket',
    providerName: 'Bitbucket',
    createQueryKey: (trpc) => trpc.linkedAccounts.bitbucket.queryKey(),
  });
