'use client';

import { useSetAuthState } from '@/hooks/useAuthState';

import { AuthForm, type AuthProvider } from '../../auth-form';

export function SignInPageClient({
  enabledProviders,
  canSignUp,
  seatLimitBlocked = false,
}: {
  enabledProviders: AuthProvider[];
  canSignUp: boolean;
  seatLimitBlocked?: boolean;
}) {
  useSetAuthState();

  return (
    <AuthForm
      enabledProviders={enabledProviders}
      canSignUp={canSignUp}
      noticeMessage={
        seatLimitBlocked
          ? 'This deployment has reached its licensed user limit. Ask an admin to free a seat or add a license key, then sign in again.'
          : null
      }
    />
  );
}
