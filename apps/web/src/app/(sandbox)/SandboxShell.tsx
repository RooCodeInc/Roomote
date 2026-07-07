'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  const { authStatus, isSignedIn } = useUser();
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

  const needsOnboarding =
    onboardingStatus && !onboardingStatus.onboardingCompletedAt;
  const sandboxLayoutValue = useMemo(
    () => ({ isSidebarVisible, setSidebarVisible, toggleSidebar }),
    [isSidebarVisible, setSidebarVisible, toggleSidebar],
  );

  useEffect(() => {
    if (needsOnboarding || isOnboardingError) {
      router.replace('/onboarding');
    }
  }, [isOnboardingError, needsOnboarding, router]);

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
        className={`md:hidden top-0 ${zIndex('NAV_HEADER')} bg-background w-full shrink-0 outline outline-b outline-border`}
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
