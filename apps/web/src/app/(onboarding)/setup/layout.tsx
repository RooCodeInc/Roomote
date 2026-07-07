'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useSetupBootstrapOpen, useUser } from '@/hooks/useUser';
import {
  FramedSurface,
  OriginMismatchAlert,
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
      className="notranslate light text-foreground relative min-h-viewport w-full overflow-auto bg-white md:h-viewport"
    >
      <div ref={setUserMenuPortalContainer} className="light text-foreground" />
      <FramedSurface
        variant="bold"
        frameClassName="h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw-0.25rem)] scroll-minimal items-center justify-center overflow-auto md:m-4 md:h-[calc(var(--effective-viewport-height)-2rem)] md:w-[calc(100vw-2rem)]"
        surfaceClassName="flex flex-col md:items-center md:justify-center overflow-auto"
      >
        {isSignedIn ? (
          <div className="z-50 flex w-full justify-end px-4 pt-4 md:fixed md:right-9 md:top-9 md:w-auto md:px-0 md:pt-0 ">
            <UserMenu portalContainer={userMenuPortalContainer} />
          </div>
        ) : null}

        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pb-6 md:flex md:justify-center md:border-l-2 md:border-black md:border-dotted md:px-0 md:pb-0 md:pl-6">
          <OriginMismatchAlert />
          {children}
        </div>
      </FramedSurface>
    </div>
  );
}
