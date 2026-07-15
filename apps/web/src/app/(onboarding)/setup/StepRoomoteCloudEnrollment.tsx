'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ArrowRight, Button, Input, Spinner } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { SetupFooter } from './SetupFooter';
import { StepTitle } from './StepTitle';

export function StepRoomoteCloudEnrollment({
  setupToken,
  mode = 'bootstrap',
  onConnected,
  onBack,
}: {
  setupToken: string | null;
  mode?: 'bootstrap' | 'authenticated';
  onConnected: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [connectionLink, setConnectionLink] = useState('');
  const bootstrapEnroll = useMutation(
    trpc.setupBootstrap.enrollRoomoteCloud.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupBootstrap.status.queryKey(),
        });
        toast.success('Roomote Cloud connected');
        onConnected();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const authenticatedEnroll = useMutation(
    trpc.setupNew.enrollRoomoteCloud.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
        toast.success('Roomote Cloud connected');
        onConnected();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const isPending = bootstrapEnroll.isPending || authenticatedEnroll.isPending;

  return (
    <form
      className="relative w-full max-w-lg space-y-6 py-2 md:py-0"
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === 'authenticated') {
          authenticatedEnroll.mutate({ connectionLink: connectionLink.trim() });
        } else {
          bootstrapEnroll.mutate({
            connectionLink: connectionLink.trim(),
            ...(setupToken ? { setupToken } : {}),
          });
        }
      }}
    >
      <StepTitle text="Connect Roomote Cloud" />
      <div className="space-y-3">
        <p>
          Keep this Roomote deployment where it is, while Roomote Cloud supplies
          the shared GitHub, Slack, and Teams apps plus managed Modal sandboxes.
        </p>
        <p className="text-sm text-muted-foreground">
          Inference stays BYOK. Copy the one-time connection link from your
          Roomote Cloud workspace and paste it below.
        </p>
      </div>
      <label className="block space-y-2">
        <span className="text-sm font-medium">Connection link</span>
        <Input
          value={connectionLink}
          onChange={(event) => setConnectionLink(event.target.value)}
          placeholder="https://cloud.example/#enrollment=…"
          autoComplete="off"
          disabled={isPending}
          data-1p-ignore
        />
      </label>
      <SetupFooter onBack={onBack} backDisabled={isPending}>
        <Button
          type="submit"
          disabled={isPending || connectionLink.trim().length === 0}
        >
          {isPending ? 'Connecting…' : 'Connect Cloud'}
          {isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </SetupFooter>
    </form>
  );
}
