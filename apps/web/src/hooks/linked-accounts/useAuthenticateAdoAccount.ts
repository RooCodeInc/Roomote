import { createUseAuthenticateOAuthLinkedAccount } from './shared';

export const useAuthenticateAdoAccount =
  createUseAuthenticateOAuthLinkedAccount({
    providerId: 'ado',
    providerName: 'Azure DevOps',
  });
