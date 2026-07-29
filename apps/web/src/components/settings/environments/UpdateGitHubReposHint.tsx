'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { useEnableGitHubApp } from '@/hooks/github';
import { useAuthorizedUser } from '@/hooks/useUser';

import { Button, Pencil } from '@/components/system';

export function UpdateGitHubReposHint() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();
  const enableGitHubApp = useEnableGitHubApp();

  const search = searchParams.toString();
  const redirectTarget = search ? `${pathname}?${search}` : pathname;

  if (!isAdmin) {
    return (
      <p className="text-xs text-muted-foreground">
        Missing a repo here? Ask an admin to update the connected GitHub
        repositories.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        Missing a repo here? Update GitHub to grant access, then come back.
      </p>
      <Button
        type="button"
        size="xs"
        variant="link"
        disabled={enableGitHubApp.isPending}
        onClick={() => {
          enableGitHubApp.mutate(
            {
              redirect: redirectTarget,
              callbackBackground: 'background',
            },
            {
              onSuccess: (result) => {
                if (!result.success) {
                  toast.error(result.error);
                  return;
                }

                if (result.mode === 'redirect') {
                  window.location.href = result.url;
                  return;
                }

                toast.success('GitHub access updated.');
              },
              onError: () =>
                toast.error('Failed to update GitHub. Please try again.'),
            },
          );
        }}
      >
        <Pencil className="size-3" />
        Update GitHub
      </Button>
    </div>
  );
}
