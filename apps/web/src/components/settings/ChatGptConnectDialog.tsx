'use client';

import { ExternalLink, Loader2 } from 'lucide-react';

import { useTRPC } from '@/trpc/client';
import { useDeviceCodeFlow } from '@/hooks/useDeviceCodeFlow';
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

  const {
    deviceAuth,
    error,
    failureReason,
    polling,
    isStartPending,
    handleOpenChange,
    restart,
  } = useDeviceCodeFlow<
    DeviceAuthStartResult,
    {
      deviceAuthId: string;
      userCode: string;
    }
  >({
    open,
    onOpenChange,
    onConnected,
    startMutationOptions: (handlers) =>
      trpc.chatgptSubscription.startDeviceAuth.mutationOptions(handlers),
    pollMutationOptions: () =>
      trpc.chatgptSubscription.pollDeviceAuth.mutationOptions(),
    getPollInput: (auth) => ({
      deviceAuthId: auth.deviceAuthId,
      userCode: auth.userCode,
    }),
    invalidateQueryKeys: () => [
      trpc.taskModels.providerSetup.queryKey(),
      trpc.taskModels.get.queryKey(),
      trpc.taskModels.launchOptions.queryKey(),
      trpc.chatgptSubscription.status.queryKey(),
      trpc.subscriptionUsage.list.queryKey(),
    ],
    successToast: 'ChatGPT subscription connected.',
    copy: {
      expired:
        'ChatGPT authorization code expired. Restart the connection to get a new code.',
      startFailed: 'Failed to start ChatGPT authorization.',
      pollFailed: 'ChatGPT authorization polling failed.',
    },
  });

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
          {isStartPending && !deviceAuth ? (
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
                  value={deviceAuth.userCode}
                  aria-label="ChatGPT device authorization code"
                  className="font-mono text-lg tracking-wider"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <a
                  href={deviceAuth.verificationUrl}
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
            disabled={isStartPending}
          >
            Cancel
          </Button>
          {error ? (
            <Button variant="outline" onClick={restart}>
              Restart
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
