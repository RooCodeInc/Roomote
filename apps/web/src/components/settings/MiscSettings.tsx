'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  Bug,
  Button,
  CopyIconButton,
  EarOff,
  Mail,
  MessageSquarePlus,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  Stethoscope,
  Switch,
} from '@/components/system';
import { Section } from '@/components/settings';
import type { MiscSettings as MiscSettingsData } from '@/trpc/commands/misc-settings';
import {
  buildRouterDebugSettingsInput,
  getRouterDebugDestinationSelection,
  ROUTER_DEBUG_ENV_FALLBACK,
  ROUTER_DEBUG_NONE,
  type RouterDebugDestinationSelection,
} from './router-diagnostics-destination';

function getBugReportUrl(diagnostics: string): string {
  const url = new URL('https://github.com/RooCodeInc/Roomote/issues/new');
  url.searchParams.set('template', 'bug.yml');
  url.searchParams.set('diagnostics', diagnostics);
  return url.toString();
}

function RouterDiagnosticsDestination() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.routerDebug.getSettings.queryKey();
  const settings = useQuery(trpc.routerDebug.getSettings.queryOptions());
  const [provider, setProvider] =
    useState<RouterDebugDestinationSelection>(ROUTER_DEBUG_NONE);
  const [channelId, setChannelId] = useState('');
  const update = useMutation(
    trpc.routerDebug.updateSettings.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(queryKey, next);
        setProvider(getRouterDebugDestinationSelection(next));
        setChannelId(next.destination?.channelId ?? '');
        toast.success('Router diagnostics destination updated.');
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  useEffect(() => {
    if (settings.data) {
      setProvider(getRouterDebugDestinationSelection(settings.data));
      setChannelId(settings.data.destination?.channelId ?? '');
    }
  }, [settings.data]);

  return (
    <Section icon={Stethoscope} title="Router diagnostics">
      <div className="space-y-3 max-w-xl">
        <p className="text-sm text-muted-foreground">
          Send router decisions to a channel or conversation on any connected
          communications provider.
        </p>
        <Select
          value={provider}
          onValueChange={(value) =>
            setProvider(value as RouterDebugDestinationSelection)
          }
          disabled={settings.isPending || update.isPending}
        >
          <SelectTrigger aria-label="Router diagnostics provider">
            {provider === ROUTER_DEBUG_NONE
              ? 'No diagnostics destination'
              : provider === ROUTER_DEBUG_ENV_FALLBACK
                ? 'Use environment fallback'
                : provider}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ROUTER_DEBUG_NONE}>
              No diagnostics destination
            </SelectItem>
            {settings.data?.envFallbackSlackChannelId ? (
              <SelectItem value={ROUTER_DEBUG_ENV_FALLBACK}>
                Use environment fallback (
                {settings.data.envFallbackSlackChannelId})
              </SelectItem>
            ) : null}
            <SelectItem value="slack">Slack</SelectItem>
            <SelectItem value="discord">Discord</SelectItem>
            <SelectItem value="teams">Microsoft Teams</SelectItem>
            <SelectItem value="telegram">Telegram</SelectItem>
          </SelectContent>
        </Select>
        {provider !== ROUTER_DEBUG_NONE &&
        provider !== ROUTER_DEBUG_ENV_FALLBACK ? (
          <Input
            aria-label="Router diagnostics destination"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            placeholder="Channel or conversation ID"
            disabled={update.isPending}
          />
        ) : null}
        <Button
          disabled={
            update.isPending ||
            (provider !== ROUTER_DEBUG_NONE &&
              provider !== ROUTER_DEBUG_ENV_FALLBACK &&
              !channelId.trim())
          }
          onClick={() =>
            update.mutate(buildRouterDebugSettingsInput(provider, channelId))
          }
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

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
      <RouterDiagnosticsDestination />
      <Section title="Feedback" icon={Mail}>
        <p className="text-muted-foreground">Help us make Roomote better!</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={getBugReportUrl(settingsQuery.data.diagnostics.plainText)}
              rel="noreferrer"
              target="_blank"
            >
              <Bug />
              File a bug
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a
              href="https://github.com/RooCodeInc/Roomote/issues/new?template=feature.yml"
              rel="noreferrer"
              target="_blank"
            >
              <MessageSquarePlus />
              Request a feature
            </a>
          </Button>
        </div>
      </Section>

      {!settingsQuery.data.cloudEnabled && (
        <Section icon={EarOff} title="Privacy">
          <div className="flex gap-3">
            <Switch
              aria-label="Toggle anonymous analytics"
              checked={settingsQuery.data.anonymousAnalyticsEnabled}
              disabled={updateMutation.isPending}
              onCheckedChange={(checked) => void handleToggle(checked === true)}
            />
            <div className="space-y-1">
              <p className="text-sm font-semibold">Anonymous analytics</p>
              <p className="text-sm text-muted-foreground">
                Share anonymous usage analytics with the Roomote team to help
                improve the product. Activity is identified only by random IDs
                that are never linked to your company, users, or repositories.
                No prompts, conversations or code is ever shared.
              </p>
            </div>
          </div>
        </Section>
      )}

      <Section icon={Stethoscope} title="Diagnostics">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This information is useful to the team when dealing with issues.
          </p>
          <div className="relative rounded-lg bg-muted p-4 pr-12 max-w-2xl">
            <CopyIconButton
              aria-label="Copy diagnostics"
              className="absolute right-2 top-2"
              content={settingsQuery.data.diagnostics.plainText}
              tooltip="Copy diagnostics"
            />
            <div className="space-y-6">
              {settingsQuery.data.diagnostics.sections.map((section) => (
                <section className="space-y-2" key={section.title}>
                  <h3 className="text-sm font-semibold">{section.title}</h3>
                  <dl className="space-y-3 text-sm">
                    {section.items.map((item) => (
                      <div
                        className="grid grid-cols-1 gap-0.5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-x-3 sm:gap-y-1.5"
                        key={item.label}
                      >
                        <dt className="text-foreground">{item.label}</dt>
                        <dd className="break-words font-mono">{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
