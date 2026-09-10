'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { FlaskConical, Skeleton, Switch } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { Section } from './Section';
import type { ExperimentalSettings as ExperimentalSettingsData } from '@/trpc/commands/experimental-settings';

export function ExperimentalSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.experimentalSettings.get.queryKey();
  const settingsQuery = useQuery(trpc.experimentalSettings.get.queryOptions());
  const updateMutation = useMutation(
    trpc.experimentalSettings.setOpenCodeCodeMode.mutationOptions(),
  );

  const handleToggle = async (enabled: boolean) => {
    const previous = settingsQuery.data;
    queryClient.setQueryData<ExperimentalSettingsData>(queryKey, {
      openCodeCodeModeEnabled: enabled,
    });

    try {
      const updated = await updateMutation.mutateAsync({ enabled });
      queryClient.setQueryData<ExperimentalSettingsData>(queryKey, updated);
      toast.success(`Code Mode ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      queryClient.setQueryData<ExperimentalSettingsData>(queryKey, previous);
      toast.error(
        error instanceof Error ? error.message : 'Failed to update Code Mode.',
      );
    }
  };

  if (settingsQuery.isPending) {
    return <Skeleton className="h-28 w-full" />;
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load experimental settings.
      </div>
    );
  }

  return (
    <Section icon={FlaskConical} title="Code Mode">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Code Mode"
          checked={settingsQuery.data.openCodeCodeModeEnabled}
          disabled={updateMutation.isPending}
          onCheckedChange={(checked) => void handleToggle(checked === true)}
        />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Defer eligible tools and discover them when needed, reducing the
            tool definitions sent with each request.
          </p>
        </div>
      </div>
    </Section>
  );
}
