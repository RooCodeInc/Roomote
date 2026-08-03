'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { useSetupBootstrapOpen, useUser } from '@/hooks/useUser';
import {
  FramedSurface,
  OriginMismatchAlert,
  RoomoteWordmark,
  UserMenu,
} from '@/components/layout';
import { Spinner } from '@/components/system';
import { cn } from '@/lib/utils';

import { SetupDocs } from './SetupDocs';
import { SetupDocsContentProvider } from './SetupDocsContext';

const SETUP_DOCS_OPEN_STORAGE_KEY = 'roomote:setup-docs-open';

export function SetupLayoutClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { authStatus, isSignedIn } = useUser();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const [userMenuPortalContainer, setUserMenuPortalContainer] =
    useState<HTMLDivElement | null>(null);
  const [isDocsOpen, setIsDocsOpen] = useState(false);
  const [docsContent, setDocsContent] = useState<ReactNode>(null);
  const hasDocsContent = docsContent !== null;

  useEffect(() => {
    try {
      setIsDocsOpen(
        window.localStorage.getItem(SETUP_DOCS_OPEN_STORAGE_KEY) === 'true',
      );
    } catch {
      // Ignore localStorage failures.
    }
  }, []);

  const handleDocsOpenChange = (isOpen: boolean) => {
    setIsDocsOpen(isOpen);

    try {
      window.localStorage.setItem(SETUP_DOCS_OPEN_STORAGE_KEY, String(isOpen));
    } catch {
      // Ignore localStorage failures.
    }
  };

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
    <SetupDocsContentProvider setContent={setDocsContent}>
      <div className="notranslate light text-foreground relative min-h-viewport w-full overflow-hidden bg-white md:h-viewport">
        <RoomoteWordmark className="absolute top-8 left-8 h-8 hidden lg:block" />
        <div
          ref={setUserMenuPortalContainer}
          className="light text-foreground"
        />
        <FramedSurface
          variant="bold"
          frameClassName="h-[calc(var(--effective-viewport-height)-0.25rem)] w-[calc(100svw)] scroll-minimal overflow-hidden"
          surfaceClassName="flex flex-col !overflow-y-auto !overflow-x-hidden md:items-center relative"
        >
          {hasDocsContent ? (
            <SetupDocs isOpen={isDocsOpen} onOpenChange={handleDocsOpenChange}>
              {docsContent}
            </SetupDocs>
          ) : null}
          {isSignedIn ? (
            <>
              <div className="z-50 flex w-full gap-2 justify-end px-4 pt-4 md:fixed md:bottom-9 md:left-9 md:w-auto md:px-0 md:pt-0">
                <RoomoteWordmark className="h-8 hidden sm:block lg:hidden" />
                <UserMenu
                  portalContainer={userMenuPortalContainer}
                  menuSide="top"
                  showPersonalSettings={false}
                />
              </div>
            </>
          ) : null}

          <div
            className={cn(
              'relative flex w-full max-w-3xl flex-col transition-transform duration-200 md:min-h-full',
              hasDocsContent &&
                isDocsOpen &&
                'min-[1050px]:-translate-x-[max(10vw,12rem)]',
            )}
          >
            <div className="pointer-events-none absolute inset-y-0 left-0 hidden border-black border-l-2 border-dotted md:block" />
            <div className="flex w-full flex-col px-4 py-6 md:my-auto md:px-0 md:py-10 md:pl-6">
              <OriginMismatchAlert />
              {children}
            </div>
          </div>
        </FramedSurface>
      </div>
    </SetupDocsContentProvider>
  );
}
