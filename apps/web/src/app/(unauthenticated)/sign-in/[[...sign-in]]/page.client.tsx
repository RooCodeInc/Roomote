'use client';

import { useSetAuthState } from '@/hooks/useAuthState';

import { AuthForm, type AuthProvider } from '../../auth-form';
import type { UserRole } from '@roomote/types';

export function SignInPageClient({
  enabledProviders,
  canSignUp,
  inviteRole = null,
  inviteInvalid = false,
  seatLimitBlocked = false,
  accountLinkHelpText = null,
}: {
  enabledProviders: AuthProvider[];
  canSignUp: boolean;
  inviteRole?: UserRole | null;
  inviteInvalid?: boolean;
  seatLimitBlocked?: boolean;
  accountLinkHelpText?: string | null;
}) {
  useSetAuthState();

  return (
    <AuthForm
      enabledProviders={enabledProviders}
      canSignUp={canSignUp}
      inviteRole={inviteRole}
      accountLinkHelpText={accountLinkHelpText}
      noticeMessage={
        seatLimitBlocked
          ? 'This deployment has reached its licensed user limit. Ask an admin to free a seat or add a license key, then sign in again.'
          : inviteInvalid
            ? 'This invitation is no longer valid. You can still sign in to an existing account.'
            : null
      }
    />
  );
}
