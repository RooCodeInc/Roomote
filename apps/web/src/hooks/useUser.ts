'use client';

import { useContext } from 'react';

import type { AuthorizedUser } from '@/types';

import {
  AuthContext,
  SetupBootstrapContext,
} from '@/components/layout/providers';

type UseUserResponse =
  | {
      authStatus: 'signed-out';
      isSignedIn: false;
      user: null;
    }
  | { authStatus: 'signed-in'; isSignedIn: true; user: AuthorizedUser };

export const useUser = (): UseUserResponse => {
  const user = useContext(AuthContext);

  if (user) {
    return { authStatus: 'signed-in', isSignedIn: true, user };
  }

  return {
    authStatus: 'signed-out',
    isSignedIn: false,
    user: null,
  };
};

export const useSetupBootstrapOpen = (): boolean =>
  useContext(SetupBootstrapContext);

export const useAuthorizedUser = () => {
  const { user } = useUser();

  if (!user) {
    throw new Error(
      'Cannot call useAuthorizedUser() from a non-authenticated component',
    );
  }

  return user;
};
