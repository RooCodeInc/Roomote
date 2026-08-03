'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import Image from 'next/image';

import {
  Avatar,
  BookMarked,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Info,
  LogOut,
  Settings,
} from '@/components/system';

import { useUser } from '@/hooks/useUser';
import { authClient } from '@/lib/auth-client';
import { DOCS_BASE_URL } from '@/lib/docs';
import { isParsableProductVersion, toReleaseTag } from '@/lib/product-version';
import { GITHUB_RELEASES_BASE_URL } from '@/lib/release-links';
import { SETTINGS_PATHS } from '@/lib/settings';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/system';

export const UserMenu = ({
  portalContainer,
  expanded = false,
  menuSide = 'left',
  showPersonalSettings = true,
  switchOrgRedirectPath,
}: {
  portalContainer?: HTMLElement | null;
  expanded?: boolean;
  menuSide?: 'top' | 'right' | 'bottom' | 'left';
  showPersonalSettings?: boolean;
  switchOrgRedirectPath?: string;
} = {}) => {
  const { isSignedIn, user } = useUser();

  if (!isSignedIn) {
    return null;
  }

  return (
    <SignedInUserMenu
      expanded={expanded}
      menuSide={menuSide}
      portalContainer={portalContainer}
      showPersonalSettings={showPersonalSettings}
      switchOrgRedirectPath={switchOrgRedirectPath}
      user={user}
    />
  );
};

function SignedInUserMenu({
  portalContainer,
  expanded,
  menuSide,
  showPersonalSettings,
  user,
}: {
  portalContainer?: HTMLElement | null;
  expanded: boolean;
  menuSide: 'top' | 'right' | 'bottom' | 'left';
  showPersonalSettings: boolean;
  switchOrgRedirectPath?: string;
  user: NonNullable<ReturnType<typeof useUser>['user']>;
}) {
  const trpc = useTRPC();
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const statusQuery = useQuery(
    trpc.releases.status.queryOptions(undefined, {
      staleTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
    }),
  );
  const handleSignOut = async () => {
    window.localStorage.removeItem(PERSONAL_THEME_STORAGE_KEY);
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = '/sign-in';
        },
      },
    });
  };

  const userDisplayName = user.name ?? 'You';
  const userEmail = user.resource.primaryEmailAddress?.emailAddress;
  const displayVersion = statusQuery.data?.displayVersion ?? null;
  const isReleaseVersion = isParsableProductVersion(displayVersion);
  const releaseUrl = displayVersion
    ? `${GITHUB_RELEASES_BASE_URL}/#release-${toReleaseTag(displayVersion)}`
    : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2"
          aria-label={userDisplayName}
        >
          <Avatar
            imageUrl={user.resource.imageUrl}
            name={user.name}
            email={userEmail}
            size="md"
            alt={userDisplayName}
            className={cn(
              'cursor-pointer hover:opacity-80',
              expanded && 'mx-0.5',
            )}
          />
          {expanded && (
            <span className="text-base font-medium truncate ml-0.5 max-w-32">
              {user.name || user.primaryEmail || 'You'}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side={menuSide}
          className="min-w-76"
          portalContainer={portalContainer}
        >
          <div className="flex items-start gap-2 p-2">
            <Avatar
              imageUrl={user.resource.imageUrl}
              name={user.name}
              email={userEmail}
              size="md"
              alt={userDisplayName}
            />
            <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col items-start">
                <div className="text-sm font-medium whitespace-nowrap ph-no-capture">
                  {userDisplayName}
                </div>
                <div className="text-sm text-muted-foreground ph-no-capture">
                  {userEmail}
                </div>
              </div>
              {showPersonalSettings ? (
                <Button variant="ghost" size="icon" asChild>
                  <Link
                    href={SETTINGS_PATHS.personal}
                    aria-label="Personal settings"
                  >
                    <Settings />
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setIsAboutOpen(true)}>
            <Info />
            <span className="grow">About Roomote</span>
            {displayVersion && (
              <span className="text-muted-foreground text-xs">
                {displayVersion}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a
              href={DOCS_BASE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2"
            >
              <BookMarked className="size-4" />
              Docs
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleSignOut}>
            <div className="flex items-center gap-2">
              <LogOut className="size-4" />
              Log out
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={isAboutOpen} onOpenChange={setIsAboutOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>About Roomote</DialogTitle>
            {displayVersion && (
              <DialogDescription>
                You&apos;re running Roomote version{' '}
                <span className="font-mono text-[0.9em]">
                  {isReleaseVersion && releaseUrl ? (
                    <a
                      href={releaseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {displayVersion}
                    </a>
                  ) : (
                    displayVersion
                  )}
                </span>
              </DialogDescription>
            )}
          </DialogHeader>

          <p className="max-w-54 min-h-14 md:max-w-none md:min-h-auto">
            Made with care by humans and robots.
          </p>
          <div>
            <Button variant="link" size="sm" asChild>
              <a
                href={GITHUB_RELEASES_BASE_URL}
                target="_blank"
                rel="noreferrer"
              >
                See all Roomote releases
                <ExternalLink />
              </a>
            </Button>
          </div>
          <Image
            src="/elements/about.png"
            alt=""
            width={100}
            height={100}
            className="absolute bottom-0 right-4 size-30"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
