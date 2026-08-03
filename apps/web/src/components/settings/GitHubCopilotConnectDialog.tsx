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

  const { deviceAuth, error, isStartPending, handleOpenChange, restart } =
    useDeviceCodeFlow<DeviceAuth, { deviceCode: string }>({
      open,
      onOpenChange,
      onConnected,
      startMutationOptions: (handlers) =>
        trpc.githubCopilotSubscription.startDeviceAuth.mutationOptions(
          handlers,
        ),
      pollMutationOptions: () =>
        trpc.githubCopilotSubscription.pollDeviceAuth.mutationOptions(),
      getPollInput: (auth) => ({ deviceCode: auth.deviceCode }),
      invalidateQueryKeys: () => [
        trpc.taskModels.providerSetup.queryKey(),
        trpc.taskModels.get.queryKey(),
        trpc.taskModels.launchOptions.queryKey(),
        trpc.githubCopilotSubscription.status.queryKey(),
        trpc.subscriptionUsage.list.queryKey(),
      ],
      successToast: 'GitHub Copilot subscription connected.',
      copy: {
        expired: 'GitHub authorization code expired. Restart the connection.',
        startFailed: 'Failed to start GitHub authorization.',
        pollFailed: 'GitHub authorization polling failed.',
      },
    });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect GitHub Copilot</DialogTitle>
          <DialogDescription>
            Sign in with a GitHub account that has an active Copilot plan.
          </DialogDescription>
        </DialogHeader>

        {deviceAuth && !error ? (
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
