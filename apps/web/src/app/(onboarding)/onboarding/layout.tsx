'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import { useUser } from '@/hooks/useUser';
import { DEFAULT_SETUP_REDIRECT_PATH, requiresSetup } from '@/lib/setup-status';
import { useTRPC } from '@/trpc/client';
import { FramedSurface, RoomoteWordmark, UserMenu } from '@/components/layout';

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
      router.replace(DEFAULT_SETUP_REDIRECT_PATH);
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
      <RoomoteWordmark className="absolute top-8 left-8 h-8 hidden lg:block" />
      <div ref={setUserMenuPortalContainer} className="light text-foreground" />
      <FramedSurface
        variant="bold"
        frameClassName="m-0.5 md:m-2 h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal overflow-hidden md:m-4 md:h-[calc(var(--effective-viewport-height)-2rem)] md:w-[calc(100vw-2rem)]"
        surfaceClassName="flex flex-col !overflow-y-auto !overflow-x-hidden md:items-center"
      >
        <div className="z-50 flex w-full gap-2 justify-end px-4 pt-4 md:fixed md:right-9 md:top-9 md:w-auto md:px-0 md:pt-0 ">
          <RoomoteWordmark className="h-8 hidden sm:block lg:hidden" />
          <UserMenu portalContainer={userMenuPortalContainer} />
        </div>
        <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
          <div className="flex w-full flex-col px-4 py-6 md:my-auto md:px-0 md:py-10 md:pl-10">
            {children}
          </div>
        </div>
      </FramedSurface>
    </div>
  );
}
