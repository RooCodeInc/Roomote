'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  Label,
  Skeleton,
  Stethoscope,
  Switch,
  Webhook,
} from '@/components/system';
import { Section } from '@/components/settings';
import { DeploymentTimeZoneSetting } from './DeploymentTimeZoneSetting';
import type { MiscSettings as MiscSettingsData } from '@/trpc/commands/misc-settings';

function getBugReportUrl(diagnostics: string): string {
  const url = new URL('https://github.com/RooCodeInc/Roomote/issues/new');
  url.searchParams.set('template', 'bug.yml');
  url.searchParams.set('diagnostics', diagnostics);
  return url.toString();
}

export function MiscSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.miscSettings.get.queryKey();
  const settingsQuery = useQuery(trpc.miscSettings.get.queryOptions());
  const updateMutation = useMutation(
    trpc.miscSettings.setAnonymousAnalytics.mutationOptions(),
  );
  const webhookMutation = useMutation(
    trpc.miscSettings.setSessionDoneWebhook.mutationOptions(),
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
      <Section title="Regional settings">
        <DeploymentTimeZoneSetting />
      </Section>
      <SessionDoneWebhookSetting
        settings={settingsQuery.data}
        isPending={webhookMutation.isPending}
        onSave={async (input) => {
          try {
            const updated = await webhookMutation.mutateAsync(input);
            queryClient.setQueryData<MiscSettingsData>(queryKey, updated);
            toast.success('Completion webhook settings saved');
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Failed to save completion webhook settings.',
            );
            throw error;
          }
        }}
      />
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

function SessionDoneWebhookSetting({
  settings,
  isPending,
  onSave,
}: {
  settings: MiscSettingsData;
  isPending: boolean;
  onSave: (input: {
    enabled: boolean;
    url: string | null;
    secret?: string;
  }) => Promise<void>;
}) {
  const configured = settings.sessionDoneWebhook;
  const [enabled, setEnabled] = useState(configured.enabled);
  const [url, setUrl] = useState(configured.url ?? '');
  const [secret, setSecret] = useState('');

  const generateSecret = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setSecret(
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  };

  return (
    <Section icon={Webhook} title="Completion webhook">
      <form
        className="max-w-2xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            enabled,
            url: url.trim() || null,
            ...(secret.trim() ? { secret: secret.trim() } : {}),
          })
            .then(() => setSecret(''))
            .catch(() => undefined);
        }}
      >
        <div className="flex gap-3">
          <Switch
            aria-label="Toggle completion webhook"
            checked={enabled}
            disabled={isPending}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <p className="text-sm text-muted-foreground">
            Send a webhook when Roomote marks a session done. Delivery is at
            least once; use the delivery ID to ignore duplicates.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="session-done-webhook-url">Endpoint URL</Label>
          <Input
            id="session-done-webhook-url"
            type="url"
            value={url}
            placeholder="https://example.com/webhooks/roomote"
            disabled={isPending}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="session-done-webhook-secret">Signing secret</Label>
          <div className="flex gap-2">
            <Input
              id="session-done-webhook-secret"
              type="password"
              value={secret}
              minLength={16}
              placeholder={
                configured.secretConfigured
                  ? 'Configured; enter or generate a new secret to replace it'
                  : 'Enter at least 16 characters or generate one'
              }
              disabled={isPending}
              onChange={(event) => setSecret(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={generateSecret}
            >
              Generate
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Roomote signs each request with HMAC-SHA256. Saved secrets are
            encrypted and never shown again.
          </p>
        </div>
        <Button type="submit" size="sm" disabled={isPending}>
          Save webhook
        </Button>
      </form>
    </Section>
  );
}
