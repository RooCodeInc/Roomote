'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLink,
  Input,
  Spinner,
} from '@/components/system';

type DeviceAuth = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
};

export function GitHubCopilotConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void | Promise<void>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  const startMutation = useMutation(
    trpc.githubCopilotSubscription.startDeviceAuth.mutationOptions({
      onSuccess: (result) => {
        setDeviceAuth(result);
        setError(null);
      },
      onError: (mutationError) => setError(mutationError.message),
    }),
  );
  const pollMutation = useMutation(
    trpc.githubCopilotSubscription.pollDeviceAuth.mutationOptions(),
  );

  function close(next: boolean) {
    if (!next) pollingRef.current = false;
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open) {
      pollingRef.current = false;
      setDeviceAuth(null);
      setError(null);
      return;
    }
    if (!deviceAuth && !startMutation.isPending && !startMutation.isError) {
      startMutation.mutate();
    }
  }, [deviceAuth, open, startMutation]);

  useEffect(() => {
    if (!open || !deviceAuth || pollingRef.current) return;
    pollingRef.current = true;

    const poll = async () => {
      let intervalMs = deviceAuth.intervalMs;
      while (pollingRef.current) {
        const result = await pollMutation.mutateAsync({
          deviceCode: deviceAuth.deviceCode,
        });
        if (result.status === 'success') {
          pollingRef.current = false;
          toast.success('GitHub Copilot subscription connected.');
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.providerSetup.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.launchOptions.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.githubCopilotSubscription.status.queryKey(),
            }),
          ]);
          await onConnected?.();
          close(false);
          return;
        }
        if (result.status === 'failed') {
          pollingRef.current = false;
          setError(result.error);
          return;
        }
        if (result.intervalMs) intervalMs += result.intervalMs;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    };

    void poll().catch((pollError: unknown) => {
      pollingRef.current = false;
      setError(
        pollError instanceof Error
          ? pollError.message
          : 'GitHub authorization polling failed.',
      );
    });
    return () => {
      pollingRef.current = false;
    };
    // The polling lifecycle is intentionally keyed only to the active device
    // flow; mutation/query objects are recreated by hooks between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAuth, open]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect GitHub Copilot</DialogTitle>
          <DialogDescription>
            Sign in with a GitHub account that has an active Copilot plan.
          </DialogDescription>
        </DialogHeader>

        {deviceAuth ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Open GitHub, then enter this one-time code:
            </p>
            <Input
              readOnly
              className="font-mono text-lg tracking-widest"
              value={deviceAuth.userCode}
              aria-label="GitHub device authorization code"
            />
            <Button asChild className="w-full">
              <a
                href={deviceAuth.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub
                <ExternalLink />
              </a>
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Waiting for authorization…
            </p>
          </div>
        ) : startMutation.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {error ? (
            <Button
              onClick={() => {
                setError(null);
                setDeviceAuth(null);
                startMutation.reset();
              }}
            >
              Restart
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
