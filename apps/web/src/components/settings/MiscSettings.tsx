'use client';

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
  Skeleton,
  Stethoscope,
  Switch,
} from '@/components/system';
import { Section } from '@/components/settings';
import type { MiscSettings as MiscSettingsData } from '@/trpc/commands/misc-settings';

function getBugReportUrl(diagnostics: string): string {
  const url = new URL('https://github.com/RooCodeInc/Roomote/issues/new');
  url.searchParams.set('template', 'bug.yml');
  url.searchParams.set('diagnostics', diagnostics);
  return url.toString();
}

function formatBuildLabel(version: string | null, gitCommitSha: string | null) {
  const parts: string[] = [];
  if (version) {
    parts.push(version);
  }
  if (gitCommitSha) {
    parts.push(gitCommitSha.slice(0, 7));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
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

  const { build, diagnostics, anonymousAnalyticsEnabled } = settingsQuery.data;
  const buildLabel = formatBuildLabel(build.version, build.gitCommitSha);

  return (
    <div className="space-y-4">
      <Section title="Feedback" icon={Mail}>
        <p className="text-muted-foreground">Help us make Roomote better!</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={getBugReportUrl(diagnostics.plainText)}
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

      <Section icon={EarOff} title="Privacy">
        <div className="flex gap-3">
          <Switch
            aria-label="Toggle anonymous analytics"
            checked={anonymousAnalyticsEnabled}
            disabled={updateMutation.isPending}
            onCheckedChange={(checked) => void handleToggle(checked === true)}
          />
          <div className="space-y-1">
            <p className="text-sm font-semibold">Anonymous analytics</p>
            <p className="text-sm text-muted-foreground">
              Share anonymous usage analytics with the Roomote team to help
              improve the product. Activity is identified only by random IDs
              that are never linked to your company, users, or repositories. No
              prompts, conversations or code is ever shared.
            </p>
          </div>
        </div>
      </Section>

      <Section icon={Stethoscope} title="Diagnostics">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This information is useful to the team when dealing with issues.
          </p>
          <div className="relative rounded-lg bg-muted p-4 pr-12 max-w-2xl">
            <CopyIconButton
              aria-label="Copy diagnostics"
              className="absolute right-2 top-2"
              content={diagnostics.plainText}
              tooltip="Copy diagnostics"
            />
            <div className="space-y-6">
              {diagnostics.sections.map((section) => (
                <section className="space-y-2" key={section.title}>
                  <h3 className="text-sm font-semibold">{section.title}</h3>
                  <dl className="grid grid-cols-[16rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                    {section.items.map((item) => (
                      <div className="contents" key={item.label}>
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

      {buildLabel ? (
        <p
          className="pt-2 text-center text-xs text-muted-foreground/60 font-mono select-all"
          title={
            [build.version, build.gitCommitSha].filter(Boolean).join(' · ') ||
            undefined
          }
        >
          {buildLabel}
        </p>
      ) : null}
    </div>
  );
}
