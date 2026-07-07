'use client';

import { TRPCReactProvider } from '@/trpc/client';

import { Toaster } from '@/components/system';
import type { AuthorizedUser } from '@/types';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';

import {
  ThemeProvider,
  AuthProvider,
  type AuthStatus,
  PersonalThemeSync,
} from './providers';
import { DebugUiAttributeController } from './DebugUiAttributeController';
import { UserAnalyticsContext } from './UserAnalyticsContext';
import { TelemetryProvider } from './TelemetryProvider';

export function RootProviders({
  authStatus,
  authUser,
  setupBootstrapOpen,
  children,
}: {
  authStatus: AuthStatus;
  authUser: AuthorizedUser | null;
  setupBootstrapOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey={PERSONAL_THEME_STORAGE_KEY}
    >
      <AuthProvider
        status={authStatus}
        user={authUser}
        setupBootstrapOpen={setupBootstrapOpen}
      >
        <TRPCReactProvider>
          <UserAnalyticsContext />
          <TelemetryProvider />
          <PersonalThemeSync />
          <DebugUiAttributeController />
          {children}
          <Toaster />
        </TRPCReactProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
