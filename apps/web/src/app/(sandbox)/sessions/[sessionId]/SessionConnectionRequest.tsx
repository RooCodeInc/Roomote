'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/trpc/client';
import { SourceControl } from '@/components/settings/SourceControl';
import { GitHubInstallRequestPending } from '@/components/github/GitHubInstallRequestPending';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Skeleton,
} from '@/components/system';

const reasons: Record<string, string> = {
  not_connected: 'Source control is not connected.',
  approval_pending: 'The GitHub installation is awaiting approval.',
  sync_pending: 'Repository synchronization is pending.',
  sync_failed:
    'Repository synchronization failed. Refresh the provider and check again.',
  repository_unavailable:
    'The requested repository is not available. Check the provider grants and refresh its repositories.',
  discovery_unavailable:
    'Source-control tools could not be reached. Check status to retry discovery; reconnecting may not be necessary.',
  forbidden: 'The requester no longer has access.',
  ready: 'Access was verified. The original Session continuation is queued.',
};

export function SessionConnectionRequest({ sessionId }: { sessionId: string }) {
  const trpc = useTRPC();
  const search = useSearchParams();
  const requestId = search.get('connectionRequest') ?? undefined;
  const [open, setOpen] = useState(false);
  const query = useQuery({
    ...trpc.sourceControl.connectionRequest.queryOptions({
      sessionId,
      requestId,
    }),
    refetchInterval: 5000,
  });
  const options = {
    onSuccess: () => {
      void query.refetch();
    },
    onError: () => toast.error('Unable to update this connection request.'),
  };
  const check = useMutation(
    trpc.sourceControl.checkConnectionRequest.mutationOptions(options),
  );
  const cancel = useMutation(
    trpc.sourceControl.cancelConnectionRequest.mutationOptions(options),
  );
  if (query.isError)
    return <p role="alert">Unable to load the connection request.</p>;
  if (query.isPending && requestId)
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-5 w-48" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  const request = query.data;
  if (!request)
    return requestId && !query.isPending ? (
      <p role="status">
        This connection request is not available in this Session.
      </p>
    ) : null;
  const pending = request.status === 'pending';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source-control access</CardTitle>
      </CardHeader>
      <CardContent>
        {request.enabled === false ? (
          <p role="status">
            Session connection requests are disabled. Source control can still
            be configured in settings; this request will not continue
            automatically.
          </p>
        ) : null}
        {request.provider && search.get(request.provider) === 'error' ? (
          <p role="alert">
            Authorization or synchronization failed. Check the provider
            configuration and try again.
          </p>
        ) : null}
        <p className="break-words ph-no-capture">
          {request.repositoryFullName ??
            request.environmentId ??
            request.provider}
        </p>
        <p role="status">
          {pending
            ? (reasons[request.reason] ?? 'Access is not ready.')
            : request.status === 'ready'
              ? reasons.ready
              : `Connection request ${request.status}.`}
        </p>
        {pending && request.enabled !== false && !request.canConnect ? (
          <p>
            A deployment admin can connect source control using this Session
            link.
          </p>
        ) : null}
        <p className="text-muted-foreground">
          Cancelling this request does not remove the deployment connection.
        </p>
        {pending &&
        request.canConnect &&
        request.reason === 'approval_pending' ? (
          <GitHubInstallRequestPending
            onApproved={() => {
              void query.refetch();
            }}
          />
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap">
        {request.canConnect ? (
          <Button onClick={() => setOpen(true)}>
            Configure source control
          </Button>
        ) : null}
        {request.canCheck ? (
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate({ sessionId, requestId: request.id })}
          >
            Check status
          </Button>
        ) : null}
        {request.canCancel ? (
          <Button
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({ sessionId, requestId: request.id })}
          >
            Cancel request
          </Button>
        ) : null}
      </CardFooter>
      {request.canConnect ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent size="2xl">
            <DialogHeader>
              <DialogTitle>Connect source control</DialogTitle>
              <DialogDescription>
                Configure access for the repository requested by this Session.
              </DialogDescription>
            </DialogHeader>
            <SourceControl
              connectionRequestId={request.id}
              connectionReturnTarget={request.url}
              provider={request.provider ?? undefined}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
