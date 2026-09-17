'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  Lock,
  RetryableLoadError,
  Skeleton,
  Switch,
} from '@/components/system';

import { Section } from './Section';

export function PrivateSessionsExperimentalSetting() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.miscSettings.privateSessionsExperiment.queryKey();
  const experimentQuery = useQuery(
    trpc.miscSettings.privateSessionsExperiment.queryOptions(),
  );
  const updateMutation = useMutation(
    trpc.miscSettings.setPrivateSessionsExperiment.mutationOptions(),
  );

  const handleToggle = async (enabled: boolean) => {
    const previous = experimentQuery.data;
    queryClient.setQueryData(queryKey, enabled);

    try {
      const updated = await updateMutation.mutateAsync({ enabled });
      queryClient.setQueryData(
        queryKey,
        updated.privateSessionsExperimentEnabled,
      );
      toast.success(`Private Sessions ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to update Private Sessions.',
      );
    }
  };

  return (
    <Section icon={Lock} title="Private Sessions">
      {experimentQuery.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : experimentQuery.isError ? (
        <RetryableLoadError
          message="Failed to load the Private Sessions experiment."
          isRetrying={experimentQuery.isFetching}
          onRetry={() => void experimentQuery.refetch()}
        />
      ) : (
        <div className="flex gap-3">
          <Switch
            aria-label="Toggle Private Sessions"
            checked={experimentQuery.data === true}
            disabled={updateMutation.isPending}
            onCheckedChange={(checked) => void handleToggle(checked === true)}
          />
          <p className="text-sm text-muted-foreground">
            Let members create owner-only web Sessions without writing to shared
            memory or publishing to shared destinations.
          </p>
        </div>
      )}
    </Section>
  );
}
