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
  CircleCheck,
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
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/system';

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
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add a GitHub repository</DialogTitle>
          <DialogDescription>
            Create the repository on GitHub — Roomote picks it up here
            automatically.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="new">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="new">New repository</TabsTrigger>
            <TabsTrigger value="fork">Fork existing</TabsTrigger>
          </TabsList>

          <TabsContent value="new" className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">
              Create the repository on github.com. An empty repository is fine —
              Roomote pushes the initial commit and sets up a basic environment
              for it.
            </p>
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
            <Button asChild className="w-full">
              <a href={newRepoUrl} target="_blank" rel="noreferrer">
                Open GitHub
                <ExternalLink />
              </a>
            </Button>
          </TabsContent>

          <TabsContent value="fork" className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">
              Paste the repository you want to fork — a GitHub URL or
              owner/repo.
            </p>
            <Input
              value={forkReference}
              onChange={(event) => setForkReference(event.target.value)}
              placeholder="https://github.com/owner/repo"
              aria-label="Repository to fork"
            />
            {forkReference.trim() && !forkTarget ? (
              <p className="text-xs text-destructive">
                Enter a GitHub repository URL or owner/repo.
              </p>
            ) : null}
            <Button asChild className="w-full" disabled={!forkUrl}>
              <a
                href={forkUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                aria-disabled={!forkUrl}
                onClick={(event) => {
                  if (!forkUrl) event.preventDefault();
                }}
              >
                Open GitHub fork page
                <ExternalLink />
              </a>
            </Button>
          </TabsContent>
        </Tabs>

        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            If the GitHub App only has access to selected repositories, also
            grant it access to the new one.
          </p>
          {isAdmin ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={enableGitHubApp.isPending}
              onClick={updateGitHubAccess}
            >
              <Pencil className="size-3" />
              Update GitHub
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Ask an admin to update the connected GitHub repositories.
            </p>
          )}
        </div>

        {detectedRepositories.length > 0 ? (
          <div className="space-y-2">
            {detectedRepositories.map((repository) => (
              <Alert key={repository.id}>
                <CircleCheck className="size-4" />
                <AlertTitle>Found {repository.fullName}</AlertTitle>
                <AlertDescription className="flex items-center justify-between gap-2">
                  <span>
                    {repository.isEmpty
                      ? 'Brand new — Roomote will initialize it during setup.'
                      : 'Ready to use.'}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => onRepositoryDetected?.(repository)}
                  >
                    Use this repository
                  </Button>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateGitHubRepoButton({
  onRepositoryDetected,
  size = 'sm',
  variant = 'outline',
  className,
}: {
  onRepositoryDetected?: (repository: DetectedRepository) => void;
  size?: 'xs' | 'sm' | 'default';
  variant?: 'outline' | 'ghost' | 'link' | 'default';
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Plus />
        Create a new repository
      </Button>
      <CreateGitHubRepoDialog
        open={open}
        onOpenChange={setOpen}
        onRepositoryDetected={(repository) => {
          setOpen(false);
          onRepositoryDetected?.(repository);
        }}
      />
    </>
  );
}
