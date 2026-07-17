'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription, Button } from '@/components/system';
import {
  useGitHubPendingInstallations,
  useResolvePendingGitHubInstallations,
} from '@/hooks/github';

/**
 * Shown while a GitHub App installation request awaits approval from an
 * organization owner. Polls for the webhook-driven completion (which deletes
 * the pending row) so the user continues automatically once it lands, and
 * offers a manual re-check that asks GitHub directly — covering the case where
 * the `installation.created` webhook never reached this deployment.
 */
export function GitHubInstallRequestPending({
  onApproved,
  footer,
}: {
  onApproved: () => void;
  footer?: ReactNode;
}) {
  const [manualCheckMessage, setManualCheckMessage] = useState<string | null>(
    null,
  );

  const pendingInstallations = useGitHubPendingInstallations({
    refetchInterval: 10_000,
  });

  const hasApprovedRef = useRef(false);
  const handleApproved = useCallback(() => {
    if (hasApprovedRef.current) {
      return;
    }

    hasApprovedRef.current = true;
    onApproved();
  }, [onApproved]);

  const resolvePendingInstallations = useResolvePendingGitHubInstallations({
    onSuccess: (result) => {
      if (result.success && result.completed > 0) {
        handleApproved();
      } else if (result.success) {
        setManualCheckMessage(
          'Not approved yet. Hang tight, this page keeps checking on its own.',
        );
      } else {
        setManualCheckMessage(result.error);
      }
    },
    onError: (error) => {
      setManualCheckMessage(error.message);
    },
  });

  const isApproved = pendingInstallations.data?.pending === false;

  useEffect(() => {
    if (isApproved) {
      handleApproved();
    }
  }, [handleApproved, isApproved]);

  return (
    <Alert className="w-sm">
      <AlertDescription>
        <div className="flex flex-col gap-4 text-center">
          <div>
            Your request is pending approval from a GitHub organization owner.
            You can wait here and we&apos;ll continue automatically once
            it&apos;s approved.
          </div>
          {manualCheckMessage && (
            <div className="text-muted-foreground">{manualCheckMessage}</div>
          )}
          <div className="flex items-center gap-2 self-center">
            <Button
              variant="secondary"
              size="sm"
              disabled={resolvePendingInstallations.isPending}
              onClick={() => {
                setManualCheckMessage(null);
                resolvePendingInstallations.mutate();
              }}
            >
              {resolvePendingInstallations.isPending
                ? 'Checking...'
                : 'Check now'}
            </Button>
            {footer}
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}
