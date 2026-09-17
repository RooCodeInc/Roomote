'use client';

import { useEffect, useMemo } from 'react';

import { Button, KeyRound, RetryableLoadError } from '@/components/system';
import { useSessionIntegrationApprovals } from '@/hooks/useSessionIntegrationApprovals';

import {
  INTEGRATION_KEYS_CHANGED_EVENT,
  openIntegrationKeyDialog,
} from './integration-key-dialog';

interface OpenIntegrationKeyRequest {
  /** Event id of the request; a new id refetches the approvals. */
  eventId: string;
  /** The approval that request created, when the tool output named it. */
  pendingRef: string | null;
}

/**
 * The card for the approval the Session owner is being asked for right now,
 * shown at the end of the conversation while the agent's request is the open
 * ask. It goes away once the key is saved, the approval expires, or the owner
 * replies and the conversation moves on. Earlier approvals the owner never
 * answered stay open in the key dialog but get no card of their own.
 */
export function PendingIntegrationKeys({
  sessionId,
  openRequest,
}: {
  sessionId: string;
  /** The key request the conversation is still waiting on; null hides the card. */
  openRequest: OpenIntegrationKeyRequest | null;
}) {
  const { data, error, errorUpdatedAt, isFetching, refetch } =
    useSessionIntegrationApprovals(sessionId);
  const openRequestId = openRequest?.eventId ?? null;
  const openPendingRef = openRequest?.pendingRef ?? null;
  useEffect(() => {
    if (openRequestId) void refetch();
  }, [openRequestId, refetch]);
  useEffect(() => {
    const handleChange = () => void refetch();
    window.addEventListener(INTEGRATION_KEYS_CHANGED_EVENT, handleChange);
    return () =>
      window.removeEventListener(INTEGRATION_KEYS_CHANGED_EVENT, handleChange);
  }, [refetch]);

  // Only the open request's approval gets a card. When the request did not
  // name one, every open approval shows rather than none.
  const pending = useMemo(() => {
    const all = data?.pending ?? [];
    return openPendingRef
      ? all.filter((item) => item.pendingRef === openPendingRef)
      : all;
  }, [data, openPendingRef]);
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
