'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useUser } from '@/hooks/useUser';
import { requiresSetup } from '@/lib/setup-status';
import { useTRPC } from '@/trpc/client';
import { FramedSurface, UserMenu } from '@/components/layout';

export default function Layout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authStatus, isSignedIn, user } = useUser();
  const [userMenuPortalContainer, setUserMenuPortalContainer] =
    useState<HTMLDivElement | null>(null);
  const trpc = useTRPC();
  const isAdmin = user?.isAdmin === true;
  const shouldRedirectToSignIn = authStatus === 'signed-out';

  useRedirectToSignIn(shouldRedirectToSignIn);

  const setupQueryEnabled = isSignedIn && isAdmin;
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    isError: isSetupError,
  } = useQuery(
    trpc.setup.status.queryOptions(undefined, {
      enabled: setupQueryEnabled,
      staleTime: 30_000,
    }),
  );

  const shouldRedirectToSetup =
    isAdmin &&
    !isSetupLoading &&
    !isSetupError &&
    setupStatus != null &&
    requiresSetup(setupStatus);

  const onboardingQueryEnabled = isSignedIn === true;
  const { data: onboardingStatus, isLoading: isOnboardingLoading } = useQuery(
    trpc.onboarding.status.queryOptions(undefined, {
      enabled: onboardingQueryEnabled,
      staleTime: 30_000,
    }),
  );

  useEffect(() => {
    if (shouldRedirectToSetup) {
      router.replace('/setup');
    }
  }, [shouldRedirectToSetup, router]);

  useEffect(() => {
    if (setupQueryEnabled && (isSetupLoading || shouldRedirectToSetup)) return;
    if (!onboardingQueryEnabled || isOnboardingLoading) return;

    if (onboardingStatus?.onboardingCompletedAt != null) {
      router.replace('/');
    }
  }, [
    setupQueryEnabled,
    isSetupLoading,
    shouldRedirectToSetup,
    onboardingQueryEnabled,
    isOnboardingLoading,
    onboardingStatus?.onboardingCompletedAt,
    router,
  ]);

  if (!isSignedIn) {
    return null;
  }
  if (setupQueryEnabled && (isSetupLoading || shouldRedirectToSetup)) {
    return null;
  }
  if (
    onboardingQueryEnabled &&
    (isOnboardingLoading || onboardingStatus?.onboardingCompletedAt != null)
  ) {
    return null;
  }

  return (
    <div className="light text-foreground relative min-h-viewport w-full overflow-hidden bg-white md:h-viewport">
      <div ref={setUserMenuPortalContainer} className="light text-foreground" />
      <FramedSurface
        variant="bold"
        frameClassName="m-0.5 md:m-2 h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal items-center justify-center overflow-auto md:m-4 md:h-[calc(var(--effective-viewport-height)-2rem)] md:w-[calc(100vw-2rem)]"
        surfaceClassName="flex flex-col md:items-center md:justify-center"
      >
        <div className="z-50 flex w-full justify-end px-4 pt-4 md:fixed md:right-9 md:top-9 md:w-auto md:px-0 md:pt-0">
          <UserMenu portalContainer={userMenuPortalContainer} />
        </div>
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pb-6 md:flex md:justify-center md:border-l-2 md:border-black md:border-dotted md:px-0 md:pb-0 md:pl-10">
          {children}
        </div>
      </FramedSurface>
    </div>
  );
}
