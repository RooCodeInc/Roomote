'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  ArrowRight,
  CircleAlert,
  Info,
  OctagonAlert,
  TriangleAlert,
  X,
} from '@/components/system';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

const DISMISSED_INCIDENTS_KEY = 'roomote-statuspage-dismissed-incidents';

function getDismissedIncidentId(): string | null {
  try {
    return localStorage.getItem(DISMISSED_INCIDENTS_KEY);
  } catch {
    return null;
  }
}

const impactPresentation = {
  critical: { className: 'bg-red-700 text-white', Icon: OctagonAlert },
  major: { className: 'bg-orange-500/75 text-black', Icon: TriangleAlert },
  minor: { className: 'bg-yellow-500/75 text-black', Icon: CircleAlert },
  none: { className: 'bg-blue-900 text-white', Icon: Info },
} as const;

export function StatusBanner() {
  const trpc = useTRPC();
  const { data: incident } = useQuery({
    ...trpc.statuspage.incident.queryOptions(),
    refetchInterval: 5 * 60 * 1000,
  });
  const [dismissedIncidentId, setDismissedIncidentId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setDismissedIncidentId(getDismissedIncidentId());
  }, []);

  const visible = incident && incident.id !== dismissedIncidentId;

  useEffect(() => {
    if (visible) {
      document.documentElement.setAttribute(
        'data-status-banner-visible',
        'true',
      );
    } else {
      document.documentElement.removeAttribute('data-status-banner-visible');
    }
    return () =>
      document.documentElement.removeAttribute('data-status-banner-visible');
  }, [visible]);

  if (!visible) return null;

  const { Icon, className } = impactPresentation[incident.impact];
  const detailsUrl = incident.shortlink ?? incident.url;

  return (
    <div
      className="bg-card h-(--status-banner-height) px-1"
      role="alert"
      aria-live="polite"
    >
      <div
        className={cn(
          'flex h-full items-center gap-2 rounded-b-xl px-3 text-sm',
          className,
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only">
          {incident.impact === 'none'
            ? 'Informational incident'
            : `${incident.impact} incident`}
        </span>
        <strong className="shrink-0 capitalize">{incident.status}</strong>
        <span className="truncate">{incident.name}</span>
        {detailsUrl ? (
          <a
            className="flex shrink-0 items-center gap-0.5 underline"
            href={detailsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Details <ArrowRight aria-hidden="true" className="size-3" />
          </a>
        ) : null}
        <button
          type="button"
          className="ml-auto shrink-0"
          aria-label="Dismiss notification"
          onClick={() => {
            localStorage.setItem(DISMISSED_INCIDENTS_KEY, incident.id);
            setDismissedIncidentId(incident.id);
          }}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
