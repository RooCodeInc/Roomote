'use client';

import { BookMarked, LogOut, Avatar } from '@/components/system';

import { useUser } from '@/hooks/useUser';
import { authClient } from '@/lib/auth-client';
import { DOCS_BASE_URL } from '@/lib/docs';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';
import { cn } from '@/lib/utils';

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
  switchOrgRedirectPath,
}: {
  portalContainer?: HTMLElement | null;
  expanded?: boolean;
  switchOrgRedirectPath?: string;
} = {}) => {
  const { isSignedIn, user } = useUser();

  if (!isSignedIn) {
    return null;
  }

  return (
    <SignedInUserMenu
      expanded={expanded}
      portalContainer={portalContainer}
      switchOrgRedirectPath={switchOrgRedirectPath}
      user={user}
    />
  );
};

function SignedInUserMenu({
  portalContainer,
  expanded,
  user,
}: {
  portalContainer?: HTMLElement | null;
  expanded: boolean;
  switchOrgRedirectPath?: string;
  user: NonNullable<ReturnType<typeof useUser>['user']>;
}) {
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
          side="left"
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
            <div className="flex flex-1 items-start justify-between">
              <div className="flex flex-col items-start">
                <div className="text-sm font-medium whitespace-nowrap ph-no-capture">
                  {userDisplayName}
                </div>
                <div className="text-sm text-muted-foreground ph-no-capture">
                  {userEmail}
                </div>
              </div>
            </div>
          </div>

          <DropdownMenuSeparator />
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
    </>
  );
}
