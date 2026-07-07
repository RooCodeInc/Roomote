'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import { Skeleton, Switch } from '@/components/system';
import { Section } from '@/components/settings';
import type { MiscSettings as MiscSettingsData } from '@/trpc/commands/misc-settings';

export function MiscSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.miscSettings.get.queryKey();
  const settingsQuery = useQuery(trpc.miscSettings.get.queryOptions());
  const updateMutation = useMutation(
    trpc.miscSettings.setAnonymousAnalytics.mutationOptions(),
  );

  const handleToggle = async (nextValue: boolean) => {
    const previous = settingsQuery.data;
    queryClient.setQueryData<MiscSettingsData>(queryKey, (current) =>
      current ? { ...current, anonymousAnalyticsEnabled: nextValue } : current,
    );

    try {
      const updated = await updateMutation.mutateAsync({ enabled: nextValue });
      queryClient.setQueryData<MiscSettingsData>(queryKey, updated);
      toast.success(
        `Anonymous analytics ${nextValue ? 'enabled' : 'disabled'}`,
      );
    } catch (error) {
      queryClient.setQueryData<MiscSettingsData>(queryKey, previous);
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to update anonymous analytics.',
      );
    }
  };

  if (settingsQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>Failed to load settings.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section title="Privacy">
        <div className="flex gap-3">
          <Switch
            aria-label="Toggle anonymous analytics"
            checked={settingsQuery.data.anonymousAnalyticsEnabled}
            disabled={updateMutation.isPending}
            onCheckedChange={(checked) => void handleToggle(checked === true)}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Anonymous analytics
            </p>
            <p className="text-sm text-foreground">
              Share anonymous usage analytics with the Roomote team to help
              improve the product. Activity is identified only by random IDs
              that are never linked to your company, users, or repositories. No
              prompts, conversations or code is ever shared.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
