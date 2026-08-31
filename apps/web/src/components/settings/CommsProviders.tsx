'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { Alert, Info, Skeleton } from '@/components/system';
import type { CommsStatus } from '@/trpc/commands/comms';

import { CommsProviderSection } from './CommsProviderSection';

type CommsProvider = CommsStatus['providers'][number];
type CommsProviderId = CommsProvider['id'];

export function CommsProviders() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const statusQueryKey = trpc.comms.status.queryKey();
  const envVarsQueryKey = trpc.environmentVariables.list.queryKey();

  const status = useQuery(trpc.comms.status.queryOptions());

  const saveAuthConfig = useMutation(
    trpc.comms.saveAuthConfig.mutationOptions({
      onSuccess: async (result) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQueryKey }),
          queryClient.invalidateQueries({ queryKey: envVarsQueryKey }),
        ]);

        if (result?.telegramWebhook) {
          if (result.telegramWebhook.registered) {
            toast.success(
              'Telegram credentials saved and the webhook is registered.',
            );
          } else {
            toast.warning(
              `Telegram credentials saved, but webhook registration failed: ${result.telegramWebhook.error ?? 'unknown error'}`,
            );
          }
          return;
        }

        if (result?.agentmail) {
          toast.success(
            `Email connected. Roomote receives mail at ${result.agentmail.inboxAddress}.`,
          );
          return;
        }

        if (result?.discord) {
          if (result.discord.registered) {
            toast.success(
              result.discord.guildCount > 0
                ? 'Discord connected and slash commands registered.'
                : 'Discord credentials saved. Add the bot to a server to finish setup.',
            );
          } else {
            toast.warning(
              `Discord credentials saved, but setup could not finish: ${result.discord.error ?? 'unknown error'}`,
            );
          }
          return;
        }

        toast.success('Communications provider credentials saved.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to save credentials.');
      },
    }),
  );

  const clearAuthConfig = useMutation(
    trpc.comms.clearAuthConfig.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQueryKey }),
          queryClient.invalidateQueries({ queryKey: envVarsQueryKey }),
        ]);
        toast.success('Communications provider credentials cleared.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to clear credentials.');
      },
    }),
  );

  const providers: CommsProvider[] = status.data?.providers ?? [];
  const hasConfiguredProvider = providers.some(
    (provider) => provider.runtimeSatisfied || provider.savedSatisfied,
  );

  const handleSave = (
    provider: CommsProviderId,
    values: Record<string, string>,
  ) => {
    saveAuthConfig.mutate({ provider, values });
  };

  const handleClear = (provider: CommsProviderId) => {
    clearAuthConfig.mutate({ provider });
  };

  if (status.isPending) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (status.isError) {
    return (
      <p className="text-sm text-destructive">
        Failed to load communications provider status.
      </p>
    );
  }

  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No communications providers are available.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {!hasConfiguredProvider && (
        <Alert variant="notice">
          <Info className="size-4" />
          <p className="max-w-xl">
            Roomote needs to be able to send and receive messages from you and
            your team to work well. Configure at least one communications
            provider to get the full experience.
          </p>
        </Alert>
      )}
      {providers.map((provider) => (
        <CommsProviderSection
          key={provider.id}
          provider={provider}
          onSave={handleSave}
          onClear={handleClear}
          savePending={
            saveAuthConfig.isPending &&
            saveAuthConfig.variables?.provider === provider.id
          }
          clearPending={
            clearAuthConfig.isPending &&
            clearAuthConfig.variables?.provider === provider.id
          }
        />
      ))}
    </div>
  );
}
