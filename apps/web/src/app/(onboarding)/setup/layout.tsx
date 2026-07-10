'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useSetupBootstrapOpen, useUser } from '@/hooks/useUser';
import {
  FramedSurface,
  OriginMismatchAlert,
  RoomoteWordmark,
  UserMenu,
} from '@/components/layout';
import { Spinner } from '@/components/system';

export default function Layout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authStatus, isSignedIn } = useUser();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const [userMenuPortalContainer, setUserMenuPortalContainer] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (authStatus === 'signed-out' && !setupBootstrapOpen) {
      router.replace('/sign-in');
    }
  }, [authStatus, router, setupBootstrapOpen]);

  if (!isSignedIn && !setupBootstrapOpen) {
    return (
      <div className="flex min-h-viewport items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div
      translate="no"
      className="notranslate light text-foreground relative min-h-viewport w-full overflow-hidden bg-white md:h-viewport"
    >
      <div ref={setUserMenuPortalContainer} className="light text-foreground" />
      <FramedSurface
        variant="bold"
        frameClassName="h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal overflow-hidden"
        surfaceClassName="flex flex-col !overflow-y-auto !overflow-x-hidden md:items-center"
      >
        {isSignedIn ? (
          <>
            <RoomoteWordmark className="absolute right-9 bottom-7 h-8 hidden md:block" />
            <div className="z-50 flex w-full justify-end px-4 pt-4 md:fixed md:right-9 md:top-9 md:w-auto md:px-0 md:pt-0 ">
              <UserMenu portalContainer={userMenuPortalContainer} />
            </div>
          </>
        ) : null}

        <div className="relative flex w-full max-w-3xl flex-col md:min-h-full">
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
          <div className="flex w-full flex-col px-4 py-6 md:my-auto md:px-0 md:py-10 md:pl-6">
            <OriginMismatchAlert />
            {children}
          </div>
        </div>
      </FramedSurface>
    </div>
  );
}
