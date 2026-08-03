'use client';

import { useTRPC } from '@/trpc/client';
import { useDeviceCodeFlow } from '@/hooks/useDeviceCodeFlow';
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

  const { deviceAuth, error, isStartPending, handleOpenChange, restart } =
    useDeviceCodeFlow<DeviceAuth, { deviceCode: string }>({
      open,
      onOpenChange,
      onConnected,
      startMutationOptions: (handlers) =>
        trpc.xaiSubscription.startDeviceAuth.mutationOptions(handlers),
      pollMutationOptions: () =>
        trpc.xaiSubscription.pollDeviceAuth.mutationOptions(),
      getPollInput: (auth) => ({ deviceCode: auth.deviceCode }),
      invalidateQueryKeys: () => [
        trpc.taskModels.providerSetup.queryKey(),
        trpc.taskModels.get.queryKey(),
        trpc.taskModels.launchOptions.queryKey(),
        trpc.xaiSubscription.status.queryKey(),
        trpc.subscriptionUsage.list.queryKey(),
      ],
      successToast: 'xAI Grok subscription connected.',
      copy: {
        expired:
          'xAI device authorization code expired. Restart the connection.',
        startFailed: 'Failed to start xAI authorization.',
        pollFailed: 'xAI authorization polling failed.',
      },
    });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect xAI Grok subscription</DialogTitle>
          <DialogDescription>
            Sign in with a SuperGrok or eligible X Premium+ account to run Grok
            models on your subscription instead of an API key.
          </DialogDescription>
        </DialogHeader>

        {deviceAuth && !error ? (
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
        ) : isStartPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          {error ? <Button onClick={restart}>Restart</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
