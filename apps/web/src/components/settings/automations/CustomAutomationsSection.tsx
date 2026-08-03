'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MAX_CUSTOM_AUTOMATIONS,
  type CustomAutomationScheduleMode,
} from '@roomote/types';

import { tryParseCronSchedule } from '@/lib/cron-schedule';
import { formatTimeZone } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';
import type { CustomAutomationListItem } from '@/trpc/commands/automations';

import {
  Button,
  BasicTooltip,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SlidersHorizontal,
  Switch,
  Textarea,
  Trash2,
} from '@/components/system';

import { ModelSelect } from '@/components/tasks/ModelSelect';

import { SlackChannelSelect } from './SlackChannelSelect';

type CustomAutomationFormState = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: CustomAutomationScheduleMode;
  environmentId: string;
  cronExpression: string;
  /** Provider/model launch override; empty string means deployment default. */
  model: string;
  targetProvider: 'none' | 'slack' | 'discord' | 'teams' | 'telegram';
  targetChannelId: string;
  targetServiceUrl: string;
};

const EMPTY_FORM: CustomAutomationFormState = {
  name: '',
  prompt: '',
  enabled: true,
  scheduleMode: 'daily',
  environmentId: '',
  cronExpression: '',
  model: '',
  targetProvider: 'slack',
  targetChannelId: '',
  targetServiceUrl: '',
};

const SCHEDULE_OPTIONS: Array<{
  value: CustomAutomationScheduleMode;
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'every_hour', label: 'Every hour' },
  { value: 'every_6_hours', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Custom schedule' },
];

function scheduleLabel(mode: CustomAutomationScheduleMode): string {
  return (
    SCHEDULE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
  );
}

function targetFromRow(row: CustomAutomationListItem): {
  provider: CustomAutomationFormState['targetProvider'];
  channelId: string;
  serviceUrl: string;
} {
  if (!row.target.provider || !row.target.externalRef) {
    return { provider: 'none', channelId: '', serviceUrl: '' };
  }

  const provider =
    row.target.provider === 'discord' ||
    row.target.provider === 'teams' ||
    row.target.provider === 'telegram'
      ? row.target.provider
      : 'slack';
  const serviceUrl =
    typeof row.target.metadata?.serviceUrl === 'string'
      ? row.target.metadata.serviceUrl
      : '';
  return {
    provider,
    channelId: row.target.externalRef ?? '',
    serviceUrl,
  };
}

function formFromRow(row: CustomAutomationListItem): CustomAutomationFormState {
  const target = targetFromRow(row);
  return {
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode: row.scheduleMode,
    environmentId: row.environmentId ?? '',
    cronExpression: row.cronExpression ?? '',
    model: row.model ?? '',
    targetProvider: target.provider,
    targetChannelId: target.channelId,
    targetServiceUrl: target.serviceUrl,
  };
}

function writeInputFromRow(row: CustomAutomationListItem) {
  const target = targetFromRow(row);

  return {
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode: row.scheduleMode,
    cronExpression: row.cronExpression,
    model: row.model,
    environmentId: row.environmentId ?? '',
    ...(target.provider !== 'none'
      ? {
          targetProvider: target.provider,
          targetChannelId: target.channelId,
        }
      : {}),
    ...(target.provider === 'teams' && target.serviceUrl
      ? { targetServiceUrl: target.serviceUrl }
      : {}),
  };
}

// The LLM summary usually already names the timezone; only append it when
// missing so it never shows twice.
function scheduleSummaryLine(summary: string, timeZone: string): string {
  const timeZoneLabel = formatTimeZone(timeZone);
  return summary.includes(timeZoneLabel) || summary.includes(timeZone)
    ? summary
    : `${summary} (${timeZoneLabel})`;
}

export function CustomAutomationsSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQuery = useQuery(
    trpc.automations.listCustomAutomations.queryOptions(),
  );
  const environmentsQuery = useQuery(trpc.environments.list.queryOptions());
  const slackChannelsQuery = useQuery(
    trpc.automations.listSlackChannels.queryOptions(),
  );
  const discordChannelsQuery = useQuery(
    trpc.automations.listDiscordChannels.queryOptions(),
  );
  const settingsQuery = useQuery(trpc.automations.getSettings.queryOptions());
  const miscSettingsQuery = useQuery(trpc.miscSettings.get.queryOptions());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<CustomAutomationFormState>(EMPTY_FORM);
  const [resolvedCron, setResolvedCron] = useState<string | null>(null);
  const [scheduleSummary, setScheduleSummary] = useState<string | null>(null);

  // New destinations default to the shared manager channel, matching where
  // the other automations report by default.
  const managerSlackChannelId =
    settingsQuery.data?.settings.managerSlackChannelId ?? '';
  const managerDiscordChannelId =
    settingsQuery.data?.settings.managerDiscordChannelId ?? '';
  const managerTeamsChannelId =
    settingsQuery.data?.settings.managerTeamsChannelId ?? '';
  const managerTelegramChatId =
    settingsQuery.data?.settings.managerTelegramChatId ?? '';

  const environmentOptions = useMemo(
    () =>
      (environmentsQuery.data ?? []).map((environment) => ({
        id: environment.id,
        name: environment.name,
      })),
    [environmentsQuery.data],
  );

  const slackOptions = useMemo(
    () =>
      (slackChannelsQuery.data?.channels ?? []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        label: channel.name.startsWith('#') ? channel.name : `#${channel.name}`,
      })),
    [slackChannelsQuery.data?.channels],
  );

  const discordOptions = useMemo(
    () =>
      (discordChannelsQuery.data?.channels ?? []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        label: channel.label ?? channel.name,
      })),
    [discordChannelsQuery.data?.channels],
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.automations.listCustomAutomations.queryKey(),
    });
  };

  const createMutation = useMutation(
    trpc.automations.createCustomAutomation.mutationOptions({
      onSuccess: async () => {
        toast.success('Custom automation created');
        setIsCreating(false);
        setForm(EMPTY_FORM);
        setResolvedCron(null);
        setScheduleSummary(null);
        await invalidate();
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to create custom automation');
      },
    }),
  );

  const updateMutation = useMutation(
    trpc.automations.updateCustomAutomation.mutationOptions({
      onSuccess: async () => {
        toast.success('Custom automation saved');
        setEditingId(null);
        setForm(EMPTY_FORM);
        setResolvedCron(null);
        setScheduleSummary(null);
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
        await invalidate();
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to save custom automation');
      },
    }),
  );

  const toggleMutation = useMutation(
    trpc.automations.updateCustomAutomation.mutationOptions({
      onSuccess: async () => {
        await invalidate();
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to update custom automation');
      },
    }),
  );

  const deleteMutation = useMutation(
    trpc.automations.deleteCustomAutomation.mutationOptions({
      onSuccess: async () => {
        toast.success('Custom automation deleted');
        await invalidate();
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to delete custom automation');
      },
    }),
  );

  const resolveScheduleMutation = useMutation(
    trpc.automations.resolveCustomAutomationSchedule.mutationOptions({
      onSuccess: (result, variables) => {
        // The input stays editable while a resolution is in flight; drop
        // responses for text the user has since changed so a stale cron
        // cannot be saved for the new schedule.
        if (variables.schedule !== form.cronExpression) {
          return;
        }
        if (result.status === 'ambiguous') {
          setResolvedCron(null);
          setScheduleSummary(null);
          toast.message(result.clarification ?? 'Clarify the schedule.');
          return;
        }
        setResolvedCron(result.cronExpression);
        setScheduleSummary(
          scheduleSummaryLine(result.summary, result.timeZone),
        );
      },
      onError: (error, variables) => {
        if (variables.schedule !== form.cronExpression) {
          return;
        }
        toast.error(error.message);
      },
    }),
  );

  // Valid five-field cron is parsed and previewed entirely client-side; the
  // server round trip (and its LLM fallback) is only for natural language.
  const schedulingTimeZone = miscSettingsQuery.data?.effectiveTimeZone;
  const clientParsedCron = useMemo(
    () =>
      schedulingTimeZone
        ? tryParseCronSchedule(form.cronExpression, schedulingTimeZone)
        : null,
    [form.cronExpression, schedulingTimeZone],
  );
  const effectiveResolvedCron =
    clientParsedCron?.cronExpression ?? resolvedCron;
  const effectiveScheduleSummary =
    clientParsedCron && schedulingTimeZone
      ? scheduleSummaryLine(clientParsedCron.summary, schedulingTimeZone)
      : scheduleSummary;

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const atCap = rows.length >= MAX_CUSTOM_AUTOMATIONS;
  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    toggleMutation.isPending;

  const closeEditor = () => {
    setIsCreating(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setResolvedCron(null);
    setScheduleSummary(null);
    if (window.location.hash.startsWith('#custom-automation-')) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    }
  };

  const editAutomation = (row: CustomAutomationListItem) => {
    setEditingId(row.id);
    setIsCreating(false);
    setForm(formFromRow(row));
    setResolvedCron(row.cronExpression ?? null);
    setScheduleSummary(null);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#custom-automation-${row.id}`,
    );
  };

  useEffect(() => {
    const openLinkedAutomation = () => {
      const prefix = '#custom-automation-';
      if (!window.location.hash.startsWith(prefix)) {
        return;
      }

      const row = rows.find(
        (candidate) =>
          candidate.id === window.location.hash.slice(prefix.length),
      );
      if (row) {
        setEditingId(row.id);
        setIsCreating(false);
        setForm(formFromRow(row));
        setResolvedCron(row.cronExpression ?? null);
        setScheduleSummary(null);
      }
    };

    openLinkedAutomation();
    window.addEventListener('hashchange', openLinkedAutomation);
    return () => window.removeEventListener('hashchange', openLinkedAutomation);
  }, [rows]);

  const saveForm = () => {
    if (!form.environmentId) {
      toast.error('Choose an environment.');
      return;
    }
    if (form.scheduleMode === 'cron' && !effectiveResolvedCron) {
      toast.error(
        resolveScheduleMutation.isPending
          ? 'Still interpreting the schedule, try again in a moment.'
          : 'Enter a valid schedule first.',
      );
      return;
    }
    if (form.targetProvider !== 'none' && !form.targetChannelId.trim()) {
      toast.error(
        'Choose a destination channel, or set the destination to None.',
      );
      return;
    }

    const payload = {
      name: form.name,
      prompt: form.prompt,
      enabled: form.enabled,
      scheduleMode: form.scheduleMode,
      cronExpression:
        form.scheduleMode === 'cron' ? effectiveResolvedCron : null,
      model: form.model || null,
      environmentId: form.environmentId,
      ...(form.targetProvider !== 'none'
        ? {
            targetProvider: form.targetProvider,
            targetChannelId: form.targetChannelId,
          }
        : {}),
      ...(form.targetProvider === 'teams' && form.targetServiceUrl.trim()
        ? { targetServiceUrl: form.targetServiceUrl.trim() }
        : {}),
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
      return;
    }

    createMutation.mutate(payload);
  };

  const renderEditor = () => (
    <DialogContent size="lg">
      <DialogHeader>
        <DialogTitle>
          {editingId ? 'Edit custom automation' : 'New custom automation'}
        </DialogTitle>
        <DialogDescription>
          Configure what runs, when it runs, and where the result is sent.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="custom-automation-name">Name</Label>
          <Input
            id="custom-automation-name"
            value={form.name}
            maxLength={100}
            disabled={busy}
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Weekly flaky-test scan"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-automation-prompt">Prompt</Label>
          <Textarea
            id="custom-automation-prompt"
            value={form.prompt}
            maxLength={8000}
            disabled={busy}
            rows={5}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                prompt: event.target.value,
              }))
            }
            placeholder="What should Roomote do on each run?"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Cadence</Label>
            <Select
              value={form.scheduleMode}
              disabled={busy}
              onValueChange={(value) => {
                setResolvedCron(null);
                setScheduleSummary(null);
                setForm((current) => ({
                  ...current,
                  scheduleMode: value as CustomAutomationScheduleMode,
                }));
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.scheduleMode === 'cron' ? (
            <div className="space-y-2">
              <Label htmlFor="custom-automation-cron">Custom schedule</Label>
              <Input
                id="custom-automation-cron"
                value={form.cronExpression}
                disabled={busy}
                placeholder="Weekdays at 9am or 0 9 * * 1-5"
                onChange={(event) => {
                  setResolvedCron(null);
                  setScheduleSummary(null);
                  setForm((current) => ({
                    ...current,
                    cronExpression: event.target.value,
                  }));
                }}
                onBlur={() => {
                  const alreadyResolvingThisInput =
                    resolveScheduleMutation.isPending &&
                    resolveScheduleMutation.variables?.schedule ===
                      form.cronExpression;
                  if (
                    !clientParsedCron &&
                    !resolvedCron &&
                    form.cronExpression.trim() &&
                    !alreadyResolvingThisInput
                  ) {
                    resolveScheduleMutation.mutate({
                      schedule: form.cronExpression,
                    });
                  }
                }}
              />
              {resolveScheduleMutation.isPending ? (
                <p className="text-sm text-muted-foreground">
                  Interpreting schedule...
                </p>
              ) : effectiveScheduleSummary ? (
                <p className="text-sm text-muted-foreground">
                  {effectiveScheduleSummary}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Environment</Label>
            <Select
              value={form.environmentId || undefined}
              disabled={busy || environmentOptions.length === 0}
              onValueChange={(value) =>
                setForm((current) => ({
                  ...current,
                  environmentId: value,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select environment" />
              </SelectTrigger>
              <SelectContent>
                {environmentOptions.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Model</Label>
            <ModelSelect
              className="w-full"
              size="default"
              ariaLabel="Automation model"
              value={form.model}
              emptyOptionLabel="Default coding model"
              disabled={busy}
              onValueChange={(value) =>
                setForm((current) => ({ ...current, model: value }))
              }
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Destination provider</Label>
            <Select
              value={form.targetProvider}
              disabled={busy}
              onValueChange={(value) =>
                setForm((current) => ({
                  ...current,
                  targetProvider:
                    value as CustomAutomationFormState['targetProvider'],
                  targetChannelId:
                    value === 'slack'
                      ? managerSlackChannelId
                      : value === 'discord'
                        ? managerDiscordChannelId
                        : value === 'teams'
                          ? managerTeamsChannelId
                          : value === 'telegram'
                            ? managerTelegramChatId
                            : '',
                  targetServiceUrl: '',
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="discord">Discord</SelectItem>
                <SelectItem value="teams">Teams</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.targetProvider === 'none' ? (
            <div className="space-y-2">
              <Label>Destination channel</Label>
              <p className="pt-2 text-sm text-muted-foreground">
                Results appear only in the task view.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Destination channel</Label>
              {form.targetProvider === 'slack' ? (
                <SlackChannelSelect
                  value={form.targetChannelId || null}
                  options={slackOptions}
                  disabled={busy}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      targetChannelId: value ?? '',
                    }))
                  }
                />
              ) : form.targetProvider === 'discord' ? (
                <Select
                  value={form.targetChannelId || undefined}
                  disabled={busy}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      targetChannelId: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Discord channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {discordOptions.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {channel.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={form.targetChannelId}
                  disabled={busy}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      targetChannelId: event.target.value,
                    }))
                  }
                  placeholder={
                    form.targetProvider === 'teams'
                      ? 'Teams conversation ID'
                      : 'Telegram chat ID'
                  }
                />
              )}
            </div>
          )}
        </div>

        {form.targetProvider === 'teams' ? (
          <div className="space-y-2">
            <Label htmlFor="custom-automation-service-url">
              Teams service URL (optional)
            </Label>
            <Input
              id="custom-automation-service-url"
              value={form.targetServiceUrl}
              disabled={busy}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  targetServiceUrl: event.target.value,
                }))
              }
              placeholder="https://smba.trafficmanager.net/..."
            />
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={form.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, enabled: checked }))
              }
            />
            <Label>Enabled</Label>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={saveForm}>
              {editingId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </DialogContent>
  );

  return (
    <section
      className="order-[-40] col-span-full space-y-3"
      aria-labelledby="custom-automations-heading"
    >
      <div className="flex items-start justify-between gap-3 pt-2">
        <div className="space-y-1">
          <h2
            id="custom-automations-heading"
            className="text-sm font-semibold text-foreground"
          >
            Custom
          </h2>
          <p className="text-sm text-muted-foreground">
            Create your own scheduled agent runs with a prompt, cadence,
            environment, and optional report channel.
          </p>
        </div>
        {!isCreating && !editingId ? (
          <Button
            type="button"
            size="sm"
            disabled={busy || atCap}
            onClick={() => {
              setIsCreating(true);
              setEditingId(null);
              setForm({
                ...EMPTY_FORM,
                targetProvider: managerSlackChannelId
                  ? 'slack'
                  : managerDiscordChannelId
                    ? 'discord'
                    : managerTeamsChannelId
                      ? 'teams'
                      : managerTelegramChatId
                        ? 'telegram'
                        : 'slack',
                targetChannelId:
                  managerSlackChannelId ||
                  managerDiscordChannelId ||
                  managerTeamsChannelId ||
                  managerTelegramChatId,
              });
              setResolvedCron(null);
              setScheduleSummary(null);
            }}
          >
            <Plus className="size-4" />
            New
          </Button>
        ) : null}
      </div>

      <Dialog
        open={isCreating || Boolean(editingId)}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        {isCreating || editingId ? renderEditor() : null}
      </Dialog>

      {listQuery.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading custom automations…
        </p>
      ) : rows.length === 0 && !isCreating ? (
        <p className="text-sm text-muted-foreground">
          No custom automations created yet.
        </p>
      ) : (
        <Card variant="snug">
          <CardContent>
            <div className="divide-y divide-background">
              {rows.map((row) => {
                const environmentName =
                  environmentOptions.find(
                    (environment) => environment.id === row.environmentId,
                  )?.name ?? 'Environment missing';
                const target = targetFromRow(row);
                const destinationLabel =
                  target.provider === 'none'
                    ? 'no report channel'
                    : target.provider === 'slack'
                      ? (slackOptions.find(
                          (option) =>
                            option.id === target.channelId ||
                            option.name === target.channelId,
                        )?.label ?? target.channelId)
                      : target.provider === 'discord'
                        ? (discordOptions.find(
                            (option) => option.id === target.channelId,
                          )?.label ?? target.channelId)
                        : target.channelId;

                return (
                  <div
                    key={row.id}
                    className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <Switch
                        aria-label={`Toggle ${row.name}`}
                        checked={row.enabled}
                        disabled={busy}
                        className="mt-0.5"
                        onCheckedChange={(enabled) =>
                          toggleMutation.mutate({
                            id: row.id,
                            ...writeInputFromRow(row),
                            enabled,
                          })
                        }
                      />
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-semibold">{row.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.scheduleMode === 'cron'
                            ? row.cronExpression
                            : scheduleLabel(row.scheduleMode)}{' '}
                          · {environmentName} ·{' '}
                          {target.provider === 'none'
                            ? destinationLabel
                            : `${target.provider}:${destinationLabel}`}{' '}
                          · Created by {row.createdByName ?? 'Unknown'}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                      <BasicTooltip content="Configure">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Configure ${row.name}`}
                          onClick={() => editAutomation(row)}
                        >
                          <SlidersHorizontal />
                        </Button>
                      </BasicTooltip>
                      <BasicTooltip content="Delete">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete custom automation “${row.name}”?`,
                              )
                            ) {
                              deleteMutation.mutate({ id: row.id });
                            }
                          }}
                          aria-label={`Delete ${row.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </BasicTooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
