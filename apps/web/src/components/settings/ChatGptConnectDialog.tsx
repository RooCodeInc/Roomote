'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
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
  Input,
  Spinner,
} from '@/components/system';

type DeviceAuthStartResult = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
};

type DevicePollFailureReason = 'blocked' | 'expired';

type DevicePollResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success' }
  | { status: 'failed'; error: string; reason?: DevicePollFailureReason };

const EXPIRED_CODE_ERROR =
  'ChatGPT authorization code expired. Restart the connection to get a new code.';

type ChatGptConnectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Invoked once after the device-code flow succeeds, in addition to the
   * shared provider/status query invalidations. Callers that surface the
   * connection in a different status surface (e.g. the setup wizard's
   * `setupNew.status`) use this to refresh that surface after a connect.
   */
  onConnected?: () => void | Promise<void>;
};

export function ChatGptConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: ChatGptConnectDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthStartResult | null>(
    null,
  );
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureReason, setFailureReason] =
    useState<DevicePollFailureReason | null>(null);
  const pollingRef = useRef(false);

  function stopPolling(
    message: string,
    reason: DevicePollFailureReason | null = null,
  ) {
    pollingRef.current = false;
    setPolling(false);
    setError(message);
    setFailureReason(reason);
  }

  const startMutation = useMutation(
    trpc.chatgptSubscription.startDeviceAuth.mutationOptions({
      onSuccess: (result) => {
        setDeviceAuth(result);
        setError(null);
      },
      onError: (mutationError) => {
        setError(
          mutationError instanceof Error
            ? mutationError.message
            : 'Failed to start ChatGPT authorization.',
        );
      },
    }),
  );

  // Poll results drive the loop below rather than mutation callbacks, so a
  // single code path owns both stopping the loop and reporting the outcome.
  const pollMutation = useMutation(
    trpc.chatgptSubscription.pollDeviceAuth.mutationOptions(),
  );

  useEffect(() => {
    if (!open) {
      pollingRef.current = false;
      setPolling(false);
      setDeviceAuth(null);
      setError(null);
      setFailureReason(null);
      return;
    }

    // Only auto-start the device-code flow once per open. Guard on
    // startMutation.isError so a failed start does not re-fire on the next
    // render (deviceAuth stays null and isPending returns to false, which
    // would otherwise loop with no backoff). The user clicks Restart to
    // retry explicitly.
    if (
      open &&
      !deviceAuth &&
      !startMutation.isPending &&
      !startMutation.isError
    ) {
      startMutation.mutate();
    }
  }, [open, deviceAuth, startMutation]);

  useEffect(() => {
    if (!open || !deviceAuth || pollingRef.current) {
      return;
    }

    pollingRef.current = true;
    setPolling(true);

    // The issuer stops accepting the code at this deadline; polling past it
    // only ever yields `deviceauth_not_found`.
    const expiresAt = Date.now() + deviceAuth.expiresInMs;

    const poll = async () => {
      let intervalMs = deviceAuth.intervalMs;

      while (pollingRef.current) {
        if (Date.now() >= expiresAt) {
          stopPolling(EXPIRED_CODE_ERROR, 'expired');
          return;
        }

        const result: DevicePollResult = await pollMutation.mutateAsync({
          deviceAuthId: deviceAuth.deviceAuthId,
          userCode: deviceAuth.userCode,
        });

        if (!pollingRef.current) {
          return;
        }

        if (result.status === 'success') {
          pollingRef.current = false;
          setPolling(false);
          toast.success('ChatGPT subscription connected.');
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.providerSetup.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.get.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.taskModels.launchOptions.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.chatgptSubscription.status.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.subscriptionUsage.list.queryKey(),
            }),
          ]);
          await onConnected?.();
          handleOpenChange(false);
          return;
        }

        if (result.status === 'failed') {
          stopPolling(result.error, result.reason ?? null);
          return;
        }

        // A rate-limited poll returns the interval to back off to.
        if (result.intervalMs) {
          intervalMs = result.intervalMs;
        }

        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          stopPolling(EXPIRED_CODE_ERROR, 'expired');
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(intervalMs, remainingMs)),
        );
      }
    };

    void poll().catch((pollError: unknown) => {
      stopPolling(
        pollError instanceof Error
          ? pollError.message
          : 'ChatGPT authorization polling failed.',
      );
    });

    return () => {
      pollingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deviceAuth]);

  function handleOpenChange(next: boolean) {
    pollingRef.current = false;
    setPolling(false);
    onOpenChange(next);
  }

  function handleRestart() {
    setDeviceAuth(null);
    setError(null);
    setFailureReason(null);
    // Clear the prior failed mutation state so the start effect can fire
    // again, then kick off a fresh device-code request.
    startMutation.reset();
    startMutation.mutate();
  }

  const userCode = deviceAuth?.userCode;
  const verificationUrl = deviceAuth?.verificationUrl;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect ChatGPT subscription</DialogTitle>
          <DialogDescription>
            Sign in with a ChatGPT Plus or Pro account to run tasks on your
            subscription instead of an OpenAI API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {startMutation.isPending && !deviceAuth ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Starting authorization…
            </div>
          ) : null}

          {error ? (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-destructive">{error}</p>
              {failureReason === 'blocked' ? (
                <p className="text-sm text-muted-foreground">
                  This usually means your ChatGPT workspace policy blocks the
                  Codex app. Ask an admin of that workspace to allow it, then
                  restart the connection. Waiting will not clear this.
                </p>
              ) : null}
            </div>
          ) : null}

          {deviceAuth && !error ? (
            <>
              <div className="space-y-2">
                <p className="text-sm">
                  Open the verification link and enter this code:
                </p>
                <Input
                  readOnly
                  value={userCode ?? ''}
                  aria-label="ChatGPT device authorization code"
                  className="font-mono text-lg tracking-wider"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <a
                  href={verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
                >
                  Open verification page
                  <ExternalLink className="size-4" />
                </a>
              </div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                {polling ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Waiting for authorization…
                  </>
                ) : (
                  <Badge variant="outline">Waiting</Badge>
                )}
              </p>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={startMutation.isPending}
          >
            Cancel
          </Button>
          {error ? (
            <Button variant="outline" onClick={handleRestart}>
              Restart
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
