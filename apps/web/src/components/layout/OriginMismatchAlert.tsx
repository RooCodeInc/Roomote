'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  TriangleAlert,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

/**
 * Warns when the browser is on an origin the auth layer will reject — the
 * typical cause is a custom domain that was attached without updating
 * ROOMOTE_APP_URL. Rendered on the pre-auth surfaces (setup wizard and
 * sign-in) so operators see the fix before sign-in fails with 403
 * "Invalid origin". Renders nothing while loading, on error, or when the
 * origin is trusted.
 */
export function OriginMismatchAlert() {
  const trpc = useTRPC();
  const [browserOrigin, setBrowserOrigin] = useState<string | null>(null);

  useEffect(() => {
    setBrowserOrigin(window.location.origin);
  }, []);

  const { data } = useQuery(
    trpc.deployment.assessBrowserOrigin.queryOptions(
      { browserOrigin: browserOrigin ?? '' },
      {
        enabled: browserOrigin !== null,
        staleTime: Infinity,
        retry: false,
      },
    ),
  );

  if (!browserOrigin || !data || data.trusted) {
    return null;
  }

  return (
    <Alert variant="warning" className="text-left">
      <TriangleAlert />
      <AlertTitle>
        This address doesn&apos;t match the configured app URL
      </AlertTitle>
      <AlertDescription>
        <p>
          You&apos;re visiting{' '}
          <span className="font-mono">{browserOrigin}</span>, but this
          deployment&apos;s configured URL is{' '}
          <a className="font-mono underline" href={data.canonicalOrigin}>
            {data.canonicalOrigin}
          </a>
          . Sign-in and OAuth requests from this address will be rejected.
        </p>
        <p>
          Either continue at the configured URL, or set{' '}
          <span className="font-mono">ROOMOTE_APP_URL={browserOrigin}</span> on
          this deployment and redeploy the app services.
        </p>
      </AlertDescription>
    </Alert>
  );
}
