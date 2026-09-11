import { useMutation } from '@tanstack/react-query';

import { authClient } from '@/lib/auth-client';
import { SETTINGS_PATHS } from '@/lib/settings';

export const useResendEmailVerification = () =>
  useMutation({
    mutationFn: async (email: string) => {
      const result = await authClient.sendVerificationEmail({
        email,
        callbackURL: SETTINGS_PATHS.personal,
      });

      if (result.error) {
        throw new Error(
          result.error.message || 'Unable to send a verification email.',
        );
      }
    },
  });
