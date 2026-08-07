'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  MessagesSquare,
  Spinner,
} from '@/components/system';

const STATE_LABELS = {
  unavailable: 'Unavailable',
  not_connected: 'Connect Slack',
  needs_permissions: 'Permissions needed',
  not_started: 'Not started',
  invitation_pending: 'Invitation pending',
  connected: 'Connected',
  action_needed: 'Action needed',
} as const;

export function SlackSupportChannelPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusQuery = useQuery(trpc.slack.supportChannel.queryOptions());
  const createChannel = useMutation(
    trpc.slack.createSupportChannel.mutationOptions({
      onSuccess: async (result) => {
        setConfirmOpen(false);
        await queryClient.invalidateQueries({
          queryKey: trpc.slack.supportChannel.queryKey(),
        });
        if (result.state === 'invitation_pending') {
          toast.success('Slack Connect invitation sent.');
        } else if (result.state === 'connected') {
          toast.success('Shared support channel is connected.');
        } else {
          toast.error(result.message);
        }
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (statusQuery.isPending || !statusQuery.data?.eligible) {
    return null;
  }

  const status = statusQuery.data;
  const canCreate =
    status.configured &&
    (status.state === 'not_started' || status.state === 'action_needed');
  const badgeVariant =
    status.state === 'connected'
      ? 'success'
      : status.state === 'invitation_pending'
        ? 'warning'
        : status.state === 'action_needed'
          ? 'destructive'
          : 'secondary';

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <MessagesSquare className="mt-0.5 size-5 shrink-0" />
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">Shared support channel</p>
              <Badge variant={badgeVariant}>{STATE_LABELS[status.state]}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{status.message}</p>
            {status.channelName ? (
              <p className="text-xs text-muted-foreground">
                #{status.channelName}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status.openUrl ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={status.openUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-4" />
                Open in Slack
              </a>
            </Button>
          ) : null}
          {canCreate ? (
            <Button size="sm" onClick={() => setConfirmOpen(true)}>
              {status.state === 'not_started' ? 'Create channel' : 'Retry'}
            </Button>
          ) : null}
        </div>
      </div>

      {status.state === 'needs_permissions' ? (
        <p className="text-xs text-muted-foreground">
          Add <code>groups:write</code> and{' '}
          <code>conversations.connect:write</code> to the Slack app, then use
          Re-auth above.
        </p>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Create a shared support channel?</DialogTitle>
            <DialogDescription>
              Roomote will create a private channel and invite Roomote support
              through Slack Connect. People outside your organization will be
              able to read messages posted there, and both organizations may
              apply their own retention policies.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={createChannel.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createChannel.mutate()}
              disabled={createChannel.isPending}
            >
              {createChannel.isPending ? <Spinner size="sm" /> : null}
              {createChannel.isPending ? 'Creating...' : 'Create and invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
