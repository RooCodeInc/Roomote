'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import type { SessionWakeupSummary } from '@roomote/types';

import { BasicTooltip, Button, Loader2, Trash2 } from '@/components/system';

function WakeupStopwatch() {
  return (
    <svg
      aria-hidden="true"
      className="lucide size-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 2h6" />
      <path d="M12 2v3" />
      <circle cx="12" cy="13" r="8" />
      <g
        className="motion-safe:animate-[spin_5s_linear_infinite]"
        style={{ transformOrigin: '12px 13px' }}
      >
        <path d="M12 13V9" />
        <circle cx="12" cy="13" r="0.5" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}

export function formatWakeupCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'Due soon';
  const seconds = Math.ceil(remainingMs / 1_000);
  if (remainingMs < 5 * 60_000) {
    return `in ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `in ${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}${hours % 24 ? ` ${hours % 24} hr` : ''}`;
}

type SessionWakeupListProps = {
  wakeups: SessionWakeupSummary[];
  clockOffsetMs?: number;
  canCancel: boolean;
  onCancel: (wakeupId: string) => Promise<void>;
  onDue?: () => void;
};

function WakeupRow({
  wakeup,
  now,
  canCancel,
  onCancel,
}: Pick<SessionWakeupListProps, 'canCancel' | 'onCancel'> & {
  wakeup: SessionWakeupSummary;
  now: number;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setPending(true);
    setError(null);
    try {
      await onCancel(wakeup.id);
    } catch {
      setError(`Could not cancel ${wakeup.name}. Try again.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <li>
      <div className="flex min-w-0 items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground">
        <WakeupStopwatch />
        <span className="min-w-0 truncate" title={wakeup.name}>
          {wakeup.name}{' '}
        </span>
        <span
          className="shrink-0 tabular-nums"
          title={wakeup.nextRunAt ?? undefined}
        >
          {formatWakeupCountdown(Date.parse(wakeup.nextRunAt!) - now)}
        </span>
        <BasicTooltip
          content={
            canCancel
              ? 'Cancel wakeup'
              : 'Only the Session owner or an admin can cancel'
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto rounded-md focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${pending ? 'Cancelling' : 'Cancel'} ${wakeup.name}`}
            aria-busy={pending}
            disabled={pending || !canCancel}
            onClick={() => void cancel()}
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
          </Button>
        </BasicTooltip>
      </div>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function SessionWakeupList({
  wakeups,
  clockOffsetMs = 0,
  canCancel,
  onCancel,
  onDue,
}: SessionWakeupListProps) {
  const [localNow, setLocalNow] = useState(() => Date.now());
  const active = wakeups
    .filter((wakeup) => wakeup.status === 'active' && wakeup.nextRunAt !== null)
    .toSorted((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
  const hasWakeups = active.length > 0;
  useEffect(() => {
    if (!hasWakeups) return;
    const timer = setInterval(() => setLocalNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasWakeups]);

  const now = localNow + clockOffsetMs;
  const dueOccurrences = active
    .filter((wakeup) => Date.parse(wakeup.nextRunAt!) <= now)
    .map((wakeup) => `${wakeup.id}:${wakeup.nextRunAt}`)
    .join('|');
  const notifyDue = useEffectEvent(() => onDue?.());
  useEffect(() => {
    // Refetch once on crossing zero, not on every tick while delivery is late.
    if (dueOccurrences) notifyDue();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect Events are non-reactive.
  }, [dueOccurrences]);

  if (!hasWakeups) return null;
  return (
    <ul aria-label="Scheduled wakeups" className="border-b border-border/50">
      {active.map((wakeup) => (
        <WakeupRow
          key={wakeup.id}
          wakeup={wakeup}
          now={now}
          canCancel={canCancel}
          onCancel={onCancel}
        />
      ))}
    </ul>
  );
}
