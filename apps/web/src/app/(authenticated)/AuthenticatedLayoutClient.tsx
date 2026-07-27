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

  // Treat the redirect target itself and any page beneath it as allowed so
  // setup can keep ownership of any remaining required bootstrap screens.
  const isRedirectingForSetup =
    setupRedirectPath !== null &&
    pathname !== setupRedirectPath &&
    !pathname.startsWith(`${setupRedirectPath}/`);
  const isRedirectingForOnboarding =
    shouldCheckOnboarding &&
    !isOnboardingLoading &&
    onboardingStatus?.onboardingCompletedAt == null &&
    !pathname.startsWith('/onboarding');

  useRedirectToSignIn(authStatus === 'signed-out');

  useEffect(() => {
    if (isRedirectingForSetup && setupRedirectPath) {
      router.replace(setupRedirectPath);
    } else if (isRedirectingForOnboarding) {
      router.replace('/onboarding');
    }
  }, [
    isRedirectingForOnboarding,
    isRedirectingForSetup,
    router,
    setupRedirectPath,
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
