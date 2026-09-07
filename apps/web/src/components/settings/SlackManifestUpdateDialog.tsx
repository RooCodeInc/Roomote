'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { useConnectSlack, useSlackInstallation } from '@/hooks/slack';
import { SETTINGS_PATHS } from '@/lib/settings';
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
  Label,
  RefreshCw,
  Spinner,
} from '@/components/system';

export function SlackManifestUpdateDialog() {
  const trpc = useTRPC();
  const slackInstallation = useSlackInstallation();
  const connectSlack = useConnectSlack(SETTINGS_PATHS.comms);
  const [open, setOpen] = useState(false);
  const [configToken, setConfigToken] = useState('');
  const [reinstallRequired, setReinstallRequired] = useState(false);

  const updateManifest = useMutation(
    trpc.slack.updateAppManifest.mutationOptions({
      onSuccess: (result) => {
        setConfigToken('');

        if (!result.success) {
          toast.error(result.error);
          return;
        }

        if (!result.changed) {
          toast.success('Slack app is already up to date');
          setOpen(false);
          return;
        }

        if (result.reinstallRequired) {
          setReinstallRequired(true);
          toast.success('Slack app manifest updated');
          return;
        }

        toast.success('Slack app updated');
        setOpen(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (!slackInstallation.data) {
    return null;
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (updateManifest.isPending || connectSlack.isPending) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfigToken('');
      setReinstallRequired(false);
    }
  };

  const handleReinstall = () => {
    connectSlack.mutate(undefined, {
      onSuccess: (url) => {
        window.location.href = url;
      },
      onError: () => toast.error('Failed to start Slack app reinstallation.'),
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <RefreshCw />
        Update app
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Update Slack app</DialogTitle>
            <DialogDescription>
              Bring this Slack app&apos;s capabilities, permissions, events, and
              callback URLs up to date with Roomote. Custom manifest settings
              are preserved.
            </DialogDescription>
          </DialogHeader>

          {reinstallRequired ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium">The manifest was updated.</p>
              <p className="text-muted-foreground">
                Slack needs you to approve the updated permissions before they
                take effect.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="slack-manifest-config-token">
                  App configuration token
                </Label>
                <Input
                  id="slack-manifest-config-token"
                  type="password"
                  autoComplete="off"
                  value={configToken}
                  onChange={(event) => setConfigToken(event.target.value)}
                  disabled={updateManifest.isPending}
                  placeholder="xoxe.xoxp-…"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Generate a fresh token under Your App Configuration Tokens in
                the{' '}
                <a
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  Slack Apps portal
                  <ExternalLink className="ml-1 inline size-3" />
                </a>
                . Roomote uses it for this update and does not store it.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={updateManifest.isPending || connectSlack.isPending}
            >
              {reinstallRequired ? 'Close' : 'Cancel'}
            </Button>
            {reinstallRequired ? (
              <Button
                type="button"
                onClick={handleReinstall}
                disabled={connectSlack.isPending}
              >
                {connectSlack.isPending ? <Spinner /> : null}
                Reinstall in Slack
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => updateManifest.mutate({ configToken })}
                disabled={!configToken.trim() || updateManifest.isPending}
              >
                {updateManifest.isPending ? <Spinner /> : <RefreshCw />}
                {updateManifest.isPending ? 'Updating...' : 'Update app'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
