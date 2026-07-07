'use client';

import { useCallback } from 'react';

import type { TelemetryEventProperties } from '@roomote/telemetry';

import { useUser } from '@/hooks/useUser';

/**
 * Capture arbitrary anonymous analytics events from client components.
 * No-ops (and never loads the tracker code) when the deployment has
 * anonymous analytics disabled.
 *
 * @public
 */
export function useTelemetry() {
  const { user } = useUser();
  const enabled = user?.anonymousAnalyticsEnabled === true;

  const capture = useCallback(
    (event: string, properties?: TelemetryEventProperties) => {
      if (!enabled) {
        return;
      }

      void import('@/lib/telemetry/tracker').then((tracker) =>
        tracker.capture(event, properties),
      );
    },
    [enabled],
  );

  return { enabled, capture };
}
