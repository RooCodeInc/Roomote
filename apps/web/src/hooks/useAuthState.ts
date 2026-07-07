'use client';

import { useCallback } from 'react';
import { useSessionStorage } from 'usehooks-ts';
import { useSearchParams } from 'next/navigation';

import { type AuthState, AuthStateParam } from '@/types';

import { useMount } from '@/hooks/useMount';

export const useAuthState = () => {
  const searchParams = useSearchParams();

  const [state, setState] = useSessionStorage<string | undefined>(
    AuthStateParam.State,
    searchParams.get(AuthStateParam.State) ?? undefined,
  );

  const [authRedirect, setAuthRedirect] = useSessionStorage<string | undefined>(
    AuthStateParam.AuthRedirect,
    searchParams.get(AuthStateParam.AuthRedirect) ?? undefined,
  );

  const set = useCallback(
    (state: AuthState) => {
      setState(state.state);
      setAuthRedirect(state.authRedirect);
    },
    [setState, setAuthRedirect],
  );

  const params = state
    ? new URLSearchParams({
        [AuthStateParam.State]: state,
        [AuthStateParam.AuthRedirect]: authRedirect ?? '/',
      })
    : undefined;

  const authState: AuthState = {
    state,
    authRedirect,
    params,
  };

  return { ...authState, set };
};

export const useSetAuthState = () => {
  const { state, authRedirect = '/', set } = useAuthState();

  useMount(() => {
    if (state) {
      set({ state, authRedirect });
    }
  });
};
