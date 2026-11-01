'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { cn } from '@/lib/utils';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ListChecks,
  Trash2,
  X,
} from '@/components/system';
import { SESSION_DELETION_DESCRIPTION } from '@/app/(sandbox)/sessions/[sessionId]/SessionDeleteAction';

type Selection = {
  active: boolean;
  pending: boolean;
  selected: Set<string>;
  toggle: (id: string) => void;
};

const SessionSelectionContext = createContext<Selection | null>(null);

export function useSessionSelectionActive() {
  return useContext(SessionSelectionContext)?.active ?? false;
}

export function SessionSelection({
  sessionIds,
  toolbar,
  children,
}: {
  sessionIds: string[];
  toolbar: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const deleteSession = useMutation(trpc.sessions.delete.mutationOptions());
  const [active, setActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  // Refreshes can remove sessions or management permissions without changing URL.
  const selected = new Set(sessionIds.filter((id) => selectedIds.has(id)));
  useEffect(() => {
    setSelectedIds((previous) => {
      const next = new Set(sessionIds.filter((id) => previous.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [sessionIds]);

  const exit = () => {
    setActive(false);
    setSelectedIds(new Set());
    setConfirming(false);
  };
  const toggle = (id: string) => {
    if (pending || !sessionIds.includes(id)) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const removeSelected = async () => {
    if (pending || selected.size === 0) return;
    setPending(true);
    const deleted = new Set<string>();
    // Reuse each session's authorization, stop, artifact, and memory safeguards.
    // Keep failures selected so a partial deletion can be retried safely.
    for (const sessionId of selected) {
      try {
        const result = await deleteSession.mutateAsync({ sessionId });
        if (result.deleted) deleted.add(sessionId);
      } catch {
        // Continue processing the other selected sessions.
      }
    }
    const failedCount = selected.size - deleted.size;
    if (deleted.size > 0) {
      toast.success(
        `Deleted ${deleted.size} session${deleted.size === 1 ? '' : 's'}.`,
      );
    }
    if (failedCount > 0) {
      toast.error(
        `${failedCount} session${failedCount === 1 ? '' : 's'} could not be deleted. Try again shortly.`,
      );
      setSelectedIds(new Set([...selected].filter((id) => !deleted.has(id))));
    } else {
      exit();
    }
    setConfirming(false);
    setPending(false);
    router.refresh();
  };

  return (
    <SessionSelectionContext.Provider
      value={{ active, pending, selected, toggle }}
    >
      <div className="flex flex-wrap items-center gap-3 border-b-4 border-b-card bg-background p-4">
        <div className="min-w-0 flex-1">{toolbar}</div>
        {active ? (
          <div
            className="flex items-center gap-2"
            role="group"
            aria-label="Session selection"
          >
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="Select all sessions on this page"
                checked={
                  selected.size === 0
                    ? false
                    : selected.size === sessionIds.length
                      ? true
                      : 'indeterminate'
                }
                disabled={pending || sessionIds.length === 0}
                onCheckedChange={(checked) =>
                  setSelectedIds(
                    checked === true ? new Set(sessionIds) : new Set(),
                  )
                }
              />
              All
            </label>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending || selected.size === 0}
              onClick={() => setConfirming(true)}
            >
              <Trash2 /> Delete ({selected.size})
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Exit selection mode"
              disabled={pending}
              onClick={exit}
            >
              <X />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Select sessions"
            title="Select sessions"
            disabled={sessionIds.length === 0}
            onClick={() => setActive(true)}
          >
            <ListChecks />
          </Button>
        )}
      </div>
      {children}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size} session{selected.size === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              {SESSION_DELETION_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending || selected.size === 0}
              onClick={() => void removeSelected()}
            >
              {pending ? 'Deleting...' : `Delete (${selected.size})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SessionSelectionContext.Provider>
  );
}

export function SessionSelectionRow({
  sessionId,
  className,
  children,
}: {
  sessionId: string;
  className: string;
  children: ReactNode;
}) {
  const selection = useContext(SessionSelectionContext);
  return (
    <div
      className={cn(
        className,
        selection?.selected.has(sessionId) && 'bg-accent-foreground/10',
      )}
    >
      {children}
    </div>
  );
}

export function SessionSelectionLink({
  sessionId,
  title,
  canManage,
  href,
  className,
  children,
}: {
  sessionId: string;
  title: string;
  canManage: boolean;
  href: string;
  className: string;
  children: ReactNode;
}) {
  const selection = useContext(SessionSelectionContext);
  if (selection?.active) {
    return (
      <button
        type="button"
        className={className}
        aria-label={`Select session: ${title}`}
        aria-pressed={selection.selected.has(sessionId)}
        disabled={!canManage || selection.pending}
        onClick={() => selection.toggle(sessionId)}
      />
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function SessionSelectionControl({
  sessionId,
  title,
  canManage,
  children,
}: {
  sessionId: string;
  title: string;
  canManage: boolean;
  children: ReactNode;
}) {
  const selection = useContext(SessionSelectionContext);
  if (!selection?.active) return children;
  return (
    <Checkbox
      className="pointer-events-auto"
      aria-label={`Select ${title}`}
      checked={selection.selected.has(sessionId)}
      disabled={!canManage || selection.pending}
      onCheckedChange={() => selection.toggle(sessionId)}
    />
  );
}
