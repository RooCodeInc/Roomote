import { createUseAuthenticateOAuthLinkedAccount } from './shared';

export const useAuthenticateMicrosoftTeamsAccount =
  createUseAuthenticateOAuthLinkedAccount({
    providerId: 'microsoft-entra-id',
    providerName: 'Microsoft Teams',
  });
