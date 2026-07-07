'use client';

import { useCallback } from 'react';
import { useSessionStorage } from 'usehooks-ts';

export const usePostAuthRedirect = () => {
  const [redirect, setRedirect] = useSessionStorage<string | undefined>(
    'post_auth_redirect',
    undefined,
  );

  const redirectToSignIn = useCallback(
    (customPath?: string) => {
      setRedirect(
        customPath ?? window.location.pathname + window.location.search,
      );

      window.location.href = '/sign-in';
    },
    [setRedirect],
  );

  const clear = useCallback(() => setRedirect(undefined), [setRedirect]);

  return { redirect, redirectToSignIn, clear };
};
