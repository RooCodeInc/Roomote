'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Badge,
  Bot,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from '@/components/system';
import { Section } from '@/components/settings';
import { useTRPC } from '@/trpc/client';

export function MondayAgentSetup() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const installationQuery = useQuery(
    trpc.mondayAgent.installation.queryOptions(),
  );
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.mondayAgent.installation.queryKey(),
    });
  const install = useMutation(
    trpc.mondayAgent.install.mutationOptions({
      onSuccess: () => {
        toast.success('monday.com external agent installed.');
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const rotate = useMutation(
    trpc.mondayAgent.rotateCredentials.mutationOptions({
      onSuccess: () => {
        toast.success('monday.com external-agent credentials rotated.');
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const uninstall = useMutation(
    trpc.mondayAgent.uninstall.mutationOptions({
      onSuccess: () => {
        setConfirmRemove(false);
        toast.success('monday.com external agent removed.');
        void invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (installationQuery.isPending || !installationQuery.data?.featureEnabled) {
    return null;
  }

  const { callbackUrl, installation } = installationQuery.data;
  const isMutating =
    install.isPending || rotate.isPending || uninstall.isPending;

  return (
    <>
      <Section
        icon={Bot}
        title="monday.com external agent beta"
        action={
          installation ? (
            <Badge
              variant={
                installation.status === 'error' ? 'destructive' : 'warning'
              }
            >
              {installation.status === 'error' ? 'Recovery needed' : 'Inactive'}
            </Badge>
          ) : undefined
        }
      >
        <p className="text-muted-foreground">
          Connect Roomote as a separate monday.com agent for assignment and
          mention triggers. This beta foundation remains inactive until task
          processing is deployed.
        </p>
        <div className="space-y-1">
          <p className="font-medium">Callback URL</p>
          <code className="bg-muted block break-all rounded-md px-3 py-2 text-xs">
            {callbackUrl}
          </code>
        </div>
        {installation ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="font-medium">
                {installation.accountName ?? 'monday.com account'}
              </p>
              <p className="text-muted-foreground text-xs">
                Agent ID {installation.agentId}. Credentials are encrypted and
                are never returned to the browser.
              </p>
            </div>
            {installation.error ? (
              <div className="text-destructive flex items-start gap-2 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{installation.error}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isMutating}
                onClick={() => rotate.mutate()}
              >
                <RefreshCw /> Rotate credentials
              </Button>
              <Button
                variant="destructive"
                disabled={isMutating}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 /> Remove agent
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button disabled={isMutating} onClick={() => install.mutate()}>
              <Bot /> Install external agent
            </Button>
            <p className="text-muted-foreground mt-2 text-xs">
              You must first link your own monday.com account in Personal
              Settings. The external agent receives separate credentials and
              board access.
            </p>
          </div>
        )}
      </Section>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Remove monday.com external agent?</DialogTitle>
            <DialogDescription>
              Roomote will disconnect the agent at monday.com before deleting
              its encrypted local credentials.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={uninstall.isPending}
              onClick={() => uninstall.mutate()}
            >
              Remove agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
