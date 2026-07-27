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
import { CloudAnalyticsProvider } from './CloudAnalyticsProvider';
import { StatusBanner } from './StatusBanner';

export function RootProviders({
  authStatus,
  authUser,
  cloudEnabled,
  intercomAppId,
  posthogProjectKey,
  posthogHost,
  setupBootstrapOpen,
  children,
}: {
  authStatus: AuthStatus;
  authUser: AuthorizedUser | null;
  cloudEnabled: boolean;
  intercomAppId?: string;
  posthogProjectKey?: string;
  posthogHost?: string;
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
          {cloudEnabled ? (
            <CloudAnalyticsProvider
              cloudEnabled
              intercomAppId={intercomAppId}
              posthogHost={posthogHost}
              posthogProjectKey={posthogProjectKey}
              userId={authUser?.userId}
            />
          ) : null}
          <PersonalThemeSync />
          <DebugUiAttributeController />
          <StatusBanner />
          {children}
          <Toaster />
        </TRPCReactProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
