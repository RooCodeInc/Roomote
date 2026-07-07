'use client';

import { createContext } from 'react';

import { type AuthorizedUser } from '@/types';

export const AuthContext = createContext<AuthorizedUser | null>(null);
export const SetupBootstrapContext = createContext<boolean>(false);
export type AuthStatus = 'signed-in' | 'signed-out';
const AuthStatusContext = createContext<AuthStatus>('signed-out');

export function AuthProvider({
  children,
  status,
  user,
  setupBootstrapOpen,
}: {
  children: React.ReactNode;
  status: AuthStatus;
  user: AuthorizedUser | null;
  setupBootstrapOpen: boolean;
}) {
  return (
    <SetupBootstrapContext.Provider value={setupBootstrapOpen}>
      <AuthStatusContext.Provider value={status}>
        <AuthContext.Provider value={user}>{children}</AuthContext.Provider>
      </AuthStatusContext.Provider>
    </SetupBootstrapContext.Provider>
  );
}
