'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { zIndex } from '@/lib';

import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

import { NavbarHeader, SideNav, Logo } from '@/components/layout';
import { Spinner } from '@/components/system';

import { SandboxLayoutContext } from './use-sandbox-layout';

interface SandboxShellProps {
  children: React.ReactNode;
  requireAuth?: boolean;
}

export function SandboxShell({
  children,
  requireAuth = true,
}: SandboxShellProps) {
  const router = useRouter();
  const { authStatus, isSignedIn, user } = useUser();
  const pathname = usePathname();
  const shouldRedirectToSignIn = requireAuth && authStatus === 'signed-out';

  useRedirectToSignIn(shouldRedirectToSignIn);

  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  const setSidebarVisible = useCallback((visible: boolean) => {
    setIsSidebarVisible(visible);
  }, []);

  const toggleSidebar = useCallback(
    () => setIsSidebarVisible((value) => !value),
    [],
  );

  const trpc = useTRPC();
  const onboardingQueryEnabled = requireAuth && isSignedIn === true;
  const { data: onboardingStatus, isError: isOnboardingError } = useQuery(
    trpc.onboarding.status.queryOptions(undefined, {
      enabled: onboardingQueryEnabled,
      staleTime: 30_000,
    }),
  );
  const { data: setupStatus } = useQuery(
    trpc.setup.status.queryOptions(undefined, {
      enabled: onboardingQueryEnabled && user?.isAdmin === true,
      staleTime: 30_000,
    }),
  );
  const { data: setupSessionStatus, isLoading: isSetupSessionLoading } =
    useQuery(
      trpc.setup.sessionStatus.queryOptions(undefined, {
        enabled:
          onboardingQueryEnabled &&
          user?.isAdmin === true &&
          setupStatus?.setupCompletedAt == null,
        staleTime: 10_000,
      }),
    );

  const needsOnboarding =
    user?.isAdmin !== true &&
    onboardingStatus &&
    !onboardingStatus.onboardingCompletedAt;
  const setupSessionPath = setupSessionStatus?.sessionId
    ? `/sessions/${setupSessionStatus.sessionId}`
    : null;
  const needsAdminSetup =
    user?.isAdmin === true && setupStatus?.setupCompletedAt == null;
  const isAllowedSetupSession =
    setupSessionPath !== null && pathname === setupSessionPath;
  const sandboxLayoutValue = useMemo(
    () => ({ isSidebarVisible, setSidebarVisible, toggleSidebar }),
    [isSidebarVisible, setSidebarVisible, toggleSidebar],
  );

  useEffect(() => {
    // Wait for the setup-session lookup before routing. Otherwise a direct
    // visit to the in-progress setup session can briefly see no session ID
    // and be redirected to /setup before the lookup resolves.
    if (needsAdminSetup && !isSetupSessionLoading && !isAllowedSetupSession) {
      router.replace(setupSessionPath ?? '/setup');
    } else if (needsOnboarding || isOnboardingError) {
      router.replace('/onboarding');
    }
  }, [
    isAllowedSetupSession,
    isOnboardingError,
    isSetupSessionLoading,
    needsAdminSetup,
    needsOnboarding,
    router,
    setupSessionPath,
  ]);

  if (shouldRedirectToSignIn) {
    return (
      <div className="flex h-viewport items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-viewport flex flex-col overflow-hidden">
      {/* Mobile-only top bar */}
      <div
        className={`md:hidden top-0 ${zIndex('NAV_HEADER')} w-full shrink-0 bg-card`}
      >
        {isSignedIn ? (
          <NavbarHeader />
        ) : (
          <div className="h-(--header-height) mx-auto px-3 flex items-center">
            <Link href="/" className="shrink-0">
              <Logo scale={0.3} />
            </Link>
          </div>
        )}
      </div>

      {/* Main layout with side nav on desktop */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isSignedIn && <SideNav />}
        <SandboxLayoutContext.Provider value={sandboxLayoutValue}>
          <div className="flex flex-1 min-h-0 min-w-0 md:rounded-l-sm md:shadow-md">
            <div className="flex flex-col min-h-0 min-w-0 flex-1">
              {children}
            </div>
          </div>
        </SandboxLayoutContext.Provider>
      </div>
    </div>
  );
}
