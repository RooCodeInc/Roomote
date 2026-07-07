import { createUseAuthenticateOAuthLinkedAccount } from './shared';

export const useAuthenticateGiteaAccount =
  createUseAuthenticateOAuthLinkedAccount({
    providerId: 'gitea',
    providerName: 'Gitea',
  });
