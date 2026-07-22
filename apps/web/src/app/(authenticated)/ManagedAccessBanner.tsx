'use client';

import { DEFAULT_MANAGED_DEPLOYMENT_ACCESS } from '@roomote/types';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  TriangleAlert,
} from '@/components/system';
import { useAuthorizedUser } from '@/hooks/useUser';

function formatDeadline(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function ManagedAccessBanner() {
  const { isAdmin, managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();
  const remediationUrl = isAdmin ? managedAccess.remediationUrl : null;

  if (
    managedAccess.state === 'active' &&
    managedAccess.reason === 'payment_past_due'
  ) {
    const deadline = formatDeadline(managedAccess.restrictionStartsAt);

    return (
      <Alert variant="warning" className="rounded-none border-0">
        <TriangleAlert />
        <AlertTitle>Billing attention needed</AlertTitle>
        <AlertDescription className="flex-wrap">
          <span>
            New tasks will be blocked{deadline ? ` on ${deadline}` : ''} unless
            billing is resolved.
          </span>
          {remediationUrl ? (
            <a className="font-semibold underline" href={remediationUrl}>
              Update billing
            </a>
          ) : (
            <span>Contact your deployment administrator.</span>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (managedAccess.state === 'read_only') {
    return (
      <Alert variant="destructive" className="rounded-none border-0">
        <TriangleAlert />
        <AlertTitle>This deployment is in read-only mode</AlertTitle>
        <AlertDescription className="flex-wrap">
          <span>
            Your data is still available, but new tasks are blocked until
            billing is resolved.
          </span>
          {remediationUrl ? (
            <a className="font-semibold underline" href={remediationUrl}>
              Update billing
            </a>
          ) : (
            <span>Contact your deployment administrator.</span>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
