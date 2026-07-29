'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  useEnableGitHubApp,
  useGitHubInstallations,
  useSyncGitHubInstallations,
} from '@/hooks/github';
import { useRepositories } from '@/hooks/source-control';
import { useRealtimePolling } from '@/hooks/useRealtimePolling';
import { useAuthorizedUser } from '@/hooks/useUser';
import { parseGitHubRepoReference } from '@/lib/github-urls';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Input,
  Label,
  Loader2,
  Pencil,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { ArrowRight, BookPlus, Check, GitFork } from 'lucide-react';

export type DetectedRepository = {
  id: string;
  fullName: string;
  isEmpty?: boolean;
};

const REPOSITORY_POLL_INTERVAL_MS = 5000;

export function CreateGitHubRepoDialog({
  open,
  onOpenChange,
  onRepositoryDetected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRepositoryDetected?: (repository: DetectedRepository) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();

  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [repositoryAction, setRepositoryAction] = useState<'new' | 'fork'>(
    'new',
  );
  const [forkReference, setForkReference] = useState('');

  const installations = useGitHubInstallations();
  const enableGitHubApp = useEnableGitHubApp();
  const syncGitHubInstallations = useSyncGitHubInstallations({
    onError: () => toast.error('Failed to refresh GitHub. Please try again.'),
  });

  const polling = useRealtimePolling({
    enabled: open,
    interval: REPOSITORY_POLL_INTERVAL_MS,
  });
  const repositories = useRepositories(
    { includeEmptyState: true },
    {
      refetchInterval: polling.refetchInterval,
      refetchIntervalInBackground: polling.refetchIntervalInBackground,
    },
  );

  const githubRepositories = useMemo<DetectedRepository[]>(
    () =>
      (repositories.data ?? [])
        .filter((repository) => repository.sourceControlProvider === 'github')
        .map((repository) => ({
          id: repository.id,
          fullName: repository.fullName,
          // `isEmpty` is present because the query passes includeEmptyState,
          // but the router output type does not narrow on that flag.
          isEmpty: (repository as { isEmpty?: boolean }).isEmpty,
        })),
    [repositories.data],
  );

  // Snapshot the repos that existed when the dialog opened; anything beyond
  // that baseline was just created (or just granted) and is offered back.
  const baselineRepositoryIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!open) {
      baselineRepositoryIdsRef.current = null;
      return;
    }

    if (
      baselineRepositoryIdsRef.current === null &&
      repositories.data !== undefined
    ) {
      baselineRepositoryIdsRef.current = new Set(
        githubRepositories.map((repository) => repository.id),
      );
    }
  }, [open, repositories.data, githubRepositories]);

  const detectedRepositories = useMemo(() => {
    const baseline = baselineRepositoryIdsRef.current;

    if (!open || baseline === null) {
      return [];
    }

    // The baseline ref is intentionally read during render: it only changes
    // together with `githubRepositories`, which is a dependency.
    return githubRepositories.filter(
      (repository) => !baseline.has(repository.id),
    );
  }, [open, githubRepositories]);

  // Returning from github.com is the most likely moment the new repo exists,
  // so trigger one authoritative GitHub sync per return to the tab instead of
  // waiting for a webhook or the next poll.
  const visibilitySyncPendingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      visibilitySyncPendingRef.current = false;
      return;
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        visibilitySyncPendingRef.current = true;
        return;
      }

      if (
        visibilitySyncPendingRef.current &&
        !syncGitHubInstallations.isPending
      ) {
        visibilitySyncPendingRef.current = false;
        syncGitHubInstallations.mutate();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [open, syncGitHubInstallations]);

  const activeInstallations = useMemo(
    () =>
      (installations.data ?? []).filter(
        (installation) => !installation.suspendedAt,
      ),
    [installations.data],
  );

  const defaultOwner =
    activeInstallations.find(
      (installation) => installation.accountType === 'Organization',
    )?.accountLogin ??
    activeInstallations[0]?.accountLogin ??
    null;
  const owner = selectedOwner ?? defaultOwner;
  const newRepoUrl = owner
    ? `https://github.com/new?owner=${encodeURIComponent(owner)}`
    : 'https://github.com/new';

  const forkTarget = parseGitHubRepoReference(forkReference);
  const forkUrl = forkTarget
    ? `https://github.com/${forkTarget.owner}/${forkTarget.repo}/fork`
    : null;

  const search = searchParams.toString();
  const redirectTarget = search ? `${pathname}?${search}` : pathname;

  const updateGitHubAccess = () => {
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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Create environment from new repo</DialogTitle>
          <DialogDescription>
            Create the repo on Github first, and Roomote will pick it up here.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={repositoryAction}
          onValueChange={(value) =>
            setRepositoryAction(value === 'fork' ? 'fork' : 'new')
          }
          className="space-y-0"
          aria-label="Repository action"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="new" id="create-repo-new" />
            <Label htmlFor="create-repo-new" className="cursor-pointer">
              <BookPlus className="size-4 text-muted-foreground" />
              New repository
            </Label>
          </div>
          {repositoryAction === 'new' && (
            <div className="space-y-2 pl-6 mb-4">
              <div className="flex gap-2 items-center">
                <p className="text-sm text-muted-foreground grow">
                  Please create it now on Github and come back here when done.
                </p>
                <Button asChild size="sm">
                  <a href={newRepoUrl} target="_blank" rel="noreferrer">
                    Go
                    <ExternalLink />
                  </a>
                </Button>
              </div>
              {activeInstallations.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="create-repo-owner">Owner</Label>
                  <Select
                    value={owner ?? undefined}
                    onValueChange={setSelectedOwner}
                  >
                    <SelectTrigger id="create-repo-owner">
                      <SelectValue placeholder="Choose an owner" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeInstallations.map((installation) => (
                        <SelectItem
                          key={installation.id}
                          value={installation.accountLogin}
                        >
                          {installation.accountLogin}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          )}
          <div className="flex items-center gap-2">
            <RadioGroupItem value="fork" id="create-repo-fork" />
            <Label htmlFor="create-repo-fork" className="cursor-pointer">
              <GitFork className="size-4 text-muted-foreground" />
              Fork existing
            </Label>
          </div>
          {repositoryAction === 'fork' && (
            <div className="space-y-2 pl-6 mb-4">
              <p className="text-sm text-muted-foreground">
                Enter the repo you want to fork, then fork it and come back here
                when done.
              </p>
              <div className="flex gap-2 items-center">
                <Input
                  value={forkReference}
                  onChange={(event) => setForkReference(event.target.value)}
                  placeholder="https://github.com/owner/repo"
                  aria-label="Repository to fork"
                />
                <Button asChild size="sm" disabled={!forkUrl}>
                  <a
                    href={forkUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!forkUrl}
                    onClick={(event) => {
                      if (!forkUrl) event.preventDefault();
                    }}
                  >
                    Go
                    <ExternalLink />
                  </a>
                </Button>
              </div>
              {forkReference.trim() && !forkTarget ? (
                <p className="text-xs text-destructive">
                  Enter a GitHub repository URL or owner/repo.
                </p>
              ) : null}
            </div>
          )}
        </RadioGroup>

        {detectedRepositories.length > 0 ? (
          <div className="space-y-2">
            {detectedRepositories.map((repository) => (
              <Alert variant="notice" key={repository.id}>
                <Check className="size-4" />
                <AlertTitle>
                  Found{' '}
                  <span className="font-mono font-medium text-[0.9em]">
                    {repository.fullName}
                  </span>
                </AlertTitle>
                <AlertDescription className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => onRepositoryDetected?.(repository)}
                  >
                    Use it
                    <ArrowRight />
                  </Button>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-foreground mt-4">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Watching for new repositories…</span>
            <Button
              type="button"
              size="xs"
              variant="link"
              className="h-auto p-0"
              disabled={syncGitHubInstallations.isPending}
              onClick={() => syncGitHubInstallations.mutate()}
            >
              Refresh now
            </Button>
          </div>
        )}

        <div className="space-y-2 mt-4">
          <p className="text-xs text-muted-foreground">
            If your GitHub integration does not have access to all repositories
            by default, grant it access to the new one or it will not be
            detected.
            {isAdmin ? (
              <Button
                type="button"
                size="xs"
                variant="link"
                className="relative top-0.5"
                disabled={enableGitHubApp.isPending}
                onClick={updateGitHubAccess}
              >
                <Pencil className="size-3" />
                Update GitHub
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                Ask an admin to update the connected GitHub repositories.
              </span>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
