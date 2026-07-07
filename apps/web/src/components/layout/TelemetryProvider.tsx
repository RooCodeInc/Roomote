'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { useUser } from '@/hooks/useUser';

/**
 * Automatic anonymous page-view tracking.
 *
 * The tracker module is loaded through a dynamic import only when the
 * deployment has anonymous analytics enabled, so disabled deployments never
 * ship or execute any tracking code in the browser.
 */
function TelemetryPageViews() {
  const { user } = useUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const enabled = user?.anonymousAnalyticsEnabled === true;

  useEffect(() => {
    if (!enabled || !pathname) {
      return;
    }

    void import('@/lib/telemetry/tracker').then((tracker) =>
      tracker.trackPageview(pathname, search),
    );
  }, [enabled, pathname, search]);

  return null;
}

export function TelemetryProvider() {
  return (
    <Suspense fallback={null}>
      <TelemetryPageViews />
    </Suspense>
  );
}
