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

export function XaiConnectDialog({
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
  /**
   * Monotonic generation bumped whenever a poll loop must die (close, restart,
   * unmount). A shared boolean is not enough: cancel + reopen can flip the
   * flag back to true and revive a stale loop that still holds the previous
   * device code.
   */
  const pollGenerationRef = useRef(0);

  const startMutation = useMutation(
    trpc.xaiSubscription.startDeviceAuth.mutationOptions({
      onSuccess: (result) => {
        setDeviceAuth(result);
        setError(null);
      },
      onError: (mutationError) => setError(mutationError.message),
    }),
  );
  const pollMutation = useMutation(
    trpc.xaiSubscription.pollDeviceAuth.mutationOptions(),
  );

  function invalidatePollLoops() {
    pollGenerationRef.current += 1;
  }

  function close(next: boolean) {
    if (!next) {
      invalidatePollLoops();
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open) {
      invalidatePollLoops();
      setDeviceAuth(null);
      setError(null);
      return;
    }
    if (!deviceAuth && !startMutation.isPending && !startMutation.isError) {
      startMutation.mutate();
    }
  }, [deviceAuth, open, startMutation]);

  useEffect(() => {
    if (!open || !deviceAuth) {
      return;
    }

    const generation = ++pollGenerationRef.current;
    const activeDeviceCode = deviceAuth.deviceCode;
    const expiresAt = Date.now() + deviceAuth.expiresInMs;

    const poll = async () => {
      let intervalMs = deviceAuth.intervalMs;
      while (pollGenerationRef.current === generation) {
        if (Date.now() >= expiresAt) {
          setError(
            'xAI device authorization code expired. Restart the connection.',
          );
          return;
        }

        const result = await pollMutation.mutateAsync({
          deviceCode: activeDeviceCode,
        });
        // Another open/close/restart may have started while we awaited.
        if (pollGenerationRef.current !== generation) {
          return;
        }
        if (result.status === 'success') {
          toast.success('xAI Grok subscription connected.');
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.providerSetup.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.launchOptions.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.xaiSubscription.status.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.subscriptionUsage.list.queryKey(),
            }),
          ]);
          if (pollGenerationRef.current !== generation) {
            return;
          }
          await onConnected?.();
          if (pollGenerationRef.current !== generation) {
            return;
          }
          close(false);
          return;
        }
        if (result.status === 'failed') {
          setError(result.error);
          return;
        }
        // slow_down returns the new absolute poll interval, not a delta.
        if (result.intervalMs) {
          intervalMs = result.intervalMs;
        }

        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          setError(
            'xAI device authorization code expired. Restart the connection.',
          );
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(intervalMs, remainingMs)),
        );
      }
    };

    void poll().catch((pollError: unknown) => {
      if (pollGenerationRef.current !== generation) {
        return;
      }
      setError(
        pollError instanceof Error
          ? pollError.message
          : 'xAI authorization polling failed.',
      );
    });
    return () => {
      // Invalidate only this effect's generation when deviceAuth/open change.
      if (pollGenerationRef.current === generation) {
        pollGenerationRef.current += 1;
      }
    };
    // The polling lifecycle is intentionally keyed only to the active device
    // flow; mutation/query objects are recreated by hooks between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAuth, open]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect xAI Grok subscription</DialogTitle>
          <DialogDescription>
            Sign in with a SuperGrok or eligible X Premium+ account to run Grok
            models on your subscription instead of an API key.
          </DialogDescription>
        </DialogHeader>

        {deviceAuth ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Open xAI, then enter this one-time code:
            </p>
            <Input
              readOnly
              className="font-mono text-lg tracking-widest"
              value={deviceAuth.userCode}
              aria-label="xAI device authorization code"
            />
            <Button asChild className="w-full">
              <a
                href={deviceAuth.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open xAI
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
                invalidatePollLoops();
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
