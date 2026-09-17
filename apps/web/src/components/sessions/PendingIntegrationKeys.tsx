'use client';

import { useEffect, useMemo } from 'react';

import { Button, KeyRound, RetryableLoadError } from '@/components/system';
import { useSessionIntegrationApprovals } from '@/hooks/useSessionIntegrationApprovals';

import {
  INTEGRATION_KEYS_CHANGED_EVENT,
  openIntegrationKeyDialog,
} from './integration-key-dialog';

/**
 * One card per approval still waiting for a key, shown to the Session owner
 * at the end of the conversation while the agent's request is the open ask.
 * It goes away once the key is saved, the approval expires, or the owner
 * replies and the conversation moves on; the approvals themselves stay open
 * in the key dialog either way.
 */
export function PendingIntegrationKeys({
  sessionId,
  openRequestId,
}: {
  sessionId: string;
  /**
   * Event id of the key request the conversation is still waiting on, or null
   * when there is none. A new id refetches; null hides the card.
   */
  openRequestId: string | null;
}) {
  const { data, error, errorUpdatedAt, isFetching, refetch } =
    useSessionIntegrationApprovals(sessionId);
  useEffect(() => {
    if (openRequestId) void refetch();
  }, [openRequestId, refetch]);
  useEffect(() => {
    const handleChange = () => void refetch();
    window.addEventListener(INTEGRATION_KEYS_CHANGED_EVENT, handleChange);
    return () =>
      window.removeEventListener(INTEGRATION_KEYS_CHANGED_EVENT, handleChange);
  }, [refetch]);

  const pending = useMemo(() => data?.pending ?? [], [data]);
  // Approvals stop accepting a key at expiresAt; refetch then so the card
  // disappears without waiting for another trigger.
  const nextExpiry = useMemo(
    () =>
      pending.reduce<number | null>((soonest, item) => {
        const at = Date.parse(item.expiresAt);
        return Number.isFinite(at) && (soonest === null || at < soonest)
          ? at
          : soonest;
      }, null),
    [pending],
  );
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = window.setTimeout(
      () => void refetch(),
      Math.max(0, nextExpiry - Date.now()) + 1_000,
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, refetch]);

  if (!openRequestId) return null;
  // React Query clears error during an initial retry, but keeps its timestamp.
  if (!data && (error || (isFetching && errorUpdatedAt > 0))) {
    return (
      <RetryableLoadError
        className="mt-4 border"
        message="Failed to load pending integration keys."
        isRetrying={isFetching}
        onRetry={() => void refetch()}
      />
    );
  }
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
