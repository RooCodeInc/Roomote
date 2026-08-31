'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';

import { zIndex } from '@/lib';
import { getSetupRedirectPath } from '@/lib/setup-status';
import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

import { NavbarHeader, SideNav, FramedSurface } from '@/components/layout';
import { CommandPaletteProvider } from '@/components/layout/CommandPaletteContext';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { McpOAuthResultFeedback } from '@/components/layout/McpOAuthResultFeedback';
import { ManagedAccessBanner } from './ManagedAccessBanner';

export default function AuthenticatedLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthenticatedLayoutShell>{children}</AuthenticatedLayoutShell>;
}

function AuthenticatedLayoutShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { authStatus, isSignedIn, user } = useUser();
  const trpc = useTRPC();
  const shouldCheckSetup = isSignedIn && user.isAdmin;
  const shouldCheckOnboarding = isSignedIn && !user.isAdmin;
  const { data: onboardingStatus, isLoading: isOnboardingLoading } = useQuery(
    trpc.onboarding.status.queryOptions(undefined, {
      enabled: shouldCheckOnboarding,
      staleTime: 30_000,
    }),
  );
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    isError: isSetupError,
  } = useQuery(
    trpc.setup.status.queryOptions(undefined, {
      enabled: shouldCheckSetup,
      staleTime: 30_000,
    }),
  );
  const setupRedirectPath =
    shouldCheckSetup && !isSetupError && setupStatus != null
      ? getSetupRedirectPath(setupStatus)
      : null;
  const { data: setupSessionStatus, isLoading: isSetupSessionLoading } =
    useQuery(
      trpc.setup.sessionStatus.queryOptions(undefined, {
        enabled: shouldCheckSetup && setupStatus?.setupCompletedAt == null,
        staleTime: 10_000,
      }),
    );
  const effectiveSetupRedirectPath =
    setupRedirectPath && isSetupSessionLoading
      ? null
      : setupRedirectPath && setupSessionStatus?.sessionId
        ? `/sessions/${setupSessionStatus.sessionId}`
        : setupRedirectPath;

  // Treat the redirect target itself and any page beneath it as allowed so
  // setup can keep ownership of any remaining required bootstrap screens.
  const isRedirectingForSetup =
    effectiveSetupRedirectPath !== null &&
    pathname !== effectiveSetupRedirectPath &&
    !pathname.startsWith(`${effectiveSetupRedirectPath}/`);
  const isRedirectingForOnboarding =
    shouldCheckOnboarding &&
    !isOnboardingLoading &&
    onboardingStatus?.onboardingCompletedAt == null &&
    !pathname.startsWith('/onboarding');

  useRedirectToSignIn(authStatus === 'signed-out');

  useEffect(() => {
    if (isRedirectingForSetup && effectiveSetupRedirectPath) {
      router.replace(effectiveSetupRedirectPath);
    } else if (isRedirectingForOnboarding) {
      router.replace('/onboarding');
    }
  }, [
    isRedirectingForOnboarding,
    isRedirectingForSetup,
    router,
    effectiveSetupRedirectPath,
  ]);

  if (!isSignedIn) {
    return null;
  }

  if (
    (shouldCheckSetup && (isSetupLoading || isRedirectingForSetup)) ||
    (shouldCheckOnboarding &&
      (isOnboardingLoading || isRedirectingForOnboarding))
  ) {
    return null;
  }

  return (
    <CommandPaletteProvider>
      <McpOAuthResultFeedback />
      <div className="flex h-effective-viewport min-h-0 flex-col bg-card">
        <div className="mx-2 rounded-b-2xl overflow-clip">
          <ManagedAccessBanner />
        </div>
        <div
          className={`md:hidden sticky top-0 ${zIndex('NAV_HEADER')} w-full bg-card`}
        >
          <NavbarHeader />
        </div>

        <div className="flex min-h-0 flex-1">
          <SideNav />

          <FramedSurface variant="basic">{children}</FramedSurface>
        </div>
      </div>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}
