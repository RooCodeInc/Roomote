'use client';

import { useEffect } from 'react';

import { Button, KeyRound } from '@/components/system';
import { useSessionIntegrationApprovals } from '@/hooks/useSessionIntegrationApprovals';

import { openIntegrationKeyDialog } from './integration-key-dialog';

/**
 * One card per approval still waiting for a key, shown to the Session owner
 * at the end of the conversation. It stays until the key is saved or the
 * approval expires, so the dialog is always one click away even after it was
 * dismissed or the agent's link scrolled out of view.
 */
export function PendingIntegrationKeys({
  sessionId,
  latestRequestId,
}: {
  sessionId: string;
  /** Event id of the newest key request in the transcript; a change refetches. */
  latestRequestId: string | null;
}) {
  const { data, refetch } = useSessionIntegrationApprovals(sessionId);
  useEffect(() => {
    if (latestRequestId) void refetch();
  }, [latestRequestId, refetch]);
  // The dialog opens and closes through the URL fragment, so a hash change is
  // the signal that a key may just have been saved.
  useEffect(() => {
    const handleHash = () => void refetch();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [refetch]);

  const pending = data?.pending ?? [];
  if (pending.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="pending-integration-keys">
      {pending.map((item) => (
        <section
          key={item.pendingRef}
          aria-label={`Add your ${item.label} key`}
          className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-4 text-sm"
        >
          <KeyRound
            aria-hidden="true"
            className="size-5 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Add your {item.label} key</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.origin} · {item.allowedMethods.join(', ')}
            </p>
          </div>
          <Button size="sm" type="button" onClick={openIntegrationKeyDialog}>
            Enter key
          </Button>
        </section>
      ))}
    </div>
  );
}
