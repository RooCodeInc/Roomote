import type { SetupAuthProviderId } from '@roomote/types';

export function getAuthProviderCallbackUrl(
  provider: SetupAuthProviderId,
  redirectUrl: string,
): string {
  if (provider !== 'slack') {
    return redirectUrl;
  }

  const params = new URLSearchParams({ redirect: redirectUrl });
  return `/api/slack/install-after-auth?${params.toString()}`;
}
