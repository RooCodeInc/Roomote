'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  NO_REPOSITORIES,
  isBackgroundAutomationUserTargetKind,
  MAX_CUSTOM_AUTOMATIONS,
  type CustomAutomationScheduleMode,
  type ReasoningEffort,
} from '@roomote/types';

import { tryParseCronSchedule } from '@/lib/cron-schedule';
import { formatDistanceToNowCompact, formatTimeZone } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';
import type { CustomAutomationListItem } from '@/trpc/commands/automations';

import {
  Button,
  BasicTooltip,
  BrandIcon,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Play,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings2,
  Skeleton,
  Switch,
  Textarea,
  Trash2,
  Zap,
} from '@/components/system';

import { ModelSelect } from '@/components/tasks/ModelSelect';
import { ReasoningEffortSelect } from '@/components/tasks/ReasoningEffortSelect';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useAuthorizedUser } from '@/hooks/useUser';

import {
  AutomationDestinationPicker,
  type AutomationDestinationProvider,
} from './AutomationDestinationPicker';
import {
  AutomationListHeader,
  AutomationListRow,
  AutomationListToolbar,
  type AutomationListFilter,
} from './AutomationList';

type ConnectedDestinationProvider = Exclude<
  AutomationDestinationProvider,
  'none'
>;

type CustomAutomationFormState = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: CustomAutomationScheduleMode;
  environmentId: string;
  cronExpression: string;
  /** Provider/model launch override; empty string means deployment default. */
  model: string;
  reasoningEffort: ReasoningEffort | null;
  targetProvider: 'none' | 'slack' | 'discord' | 'teams' | 'telegram';
  targetMode: 'channel' | 'direct_message';
  targetChannelId: string;
};

const EMPTY_FORM: CustomAutomationFormState = {
  name: '',
  prompt: '',
  enabled: true,
  scheduleMode: 'daily',
  environmentId: '',
  cronExpression: '',
  model: '',
  reasoningEffort: null,
  targetProvider: 'slack',
  targetMode: 'channel',
  targetChannelId: '',
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

const DESTINATION_OPTIONS: Array<{
  value: ConnectedDestinationProvider;
  label: string;
  capability:
    | 'slackConnected'
    | 'discordConnected'
    | 'teamsConnected'
    | 'telegramConnected';
}> = [
  { value: 'slack', label: 'Slack', capability: 'slackConnected' },
  { value: 'discord', label: 'Discord', capability: 'discordConnected' },
  { value: 'teams', label: 'Teams', capability: 'teamsConnected' },
  { value: 'telegram', label: 'Telegram', capability: 'telegramConnected' },
];

function scheduleLabel(mode: CustomAutomationScheduleMode): string {
  return (
    SCHEDULE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
  );
}

function cadenceLabel(row: CustomAutomationListItem): string {
  if (row.scheduleMode !== 'cron') {
    return scheduleLabel(row.scheduleMode);
  }

  return row.cronExpression
    ? (tryParseCronSchedule(row.cronExpression, 'UTC')?.summary ??
        'Custom schedule')
    : 'Custom schedule';
}

function CustomAutomationRunButton({
  automation,
  disabled,
}: {
  automation: CustomAutomationListItem;
  disabled: boolean;
}) {
  const trpc = useTRPC();
  const triggerMutation = useMutation({
    ...trpc.automations.triggerCustomAutomation.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'launched':
            toast.success(`Running ${automation.name} now`, {
              action: {
                label: 'View task',
                onClick: () => window.open(`/task/${result.taskId}`, '_blank'),
              },
            });
            break;
          case 'queued':
            toast.success(`${automation.name} was queued to run.`);
            break;
          case 'completed':
            toast.success(`${automation.name} ran successfully.`);
            break;
          case 'skipped':
            toast.info(
              `${automation.name} had nothing to do: ${result.reason}`,
            );
            break;
          case 'failed':
            toast.error(`${automation.name} failed: ${result.error}`);
            break;
        }
      },
      onError: (error) => {
        toast.error(error.message || `Failed to run ${automation.name}`);
      },
    }),
    mutationKey: ['customAutomationRun', automation.id],
  });

  return (
    <BasicTooltip content="Run now">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled || triggerMutation.isPending || !automation.enabled}
        aria-label={`Run ${automation.name} now`}
        onClick={() => triggerMutation.mutate({ id: automation.id })}
      >
        <Play />
      </Button>
    </BasicTooltip>
  );
}

function targetFromRow(row: CustomAutomationListItem): {
  provider: CustomAutomationFormState['targetProvider'];
  mode: CustomAutomationFormState['targetMode'];
  channelId: string;
} {
  if (!row.target.provider || !row.target.externalRef) {
    return {
      provider: 'none',
      mode: 'channel',
      channelId: '',
    };
  }

  const provider =
    row.target.provider === 'discord' ||
    row.target.provider === 'teams' ||
    row.target.provider === 'telegram'
      ? row.target.provider
      : 'slack';
  return {
    provider,
    mode: isBackgroundAutomationUserTargetKind(row.target.targetKind)
      ? 'direct_message'
      : 'channel',
    channelId: isBackgroundAutomationUserTargetKind(row.target.targetKind)
      ? ''
      : (row.target.externalRef ?? ''),
  };
}

function formFromRow(
  row: CustomAutomationListItem,
  connectedProviders: readonly ConnectedDestinationProvider[] | null,
): CustomAutomationFormState {
  const target = targetFromRow(row);
  const targetIsConnected =
    connectedProviders === null ||
    target.provider === 'none' ||
    connectedProviders.includes(target.provider);
  return {
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    scheduleMode: row.scheduleMode,
    environmentId: row.environmentId ?? '',
    cronExpression: row.cronExpression ?? '',
    model: row.model ?? '',
    reasoningEffort: row.reasoningEffort,
    targetProvider: targetIsConnected ? target.provider : 'none',
    targetMode: target.mode,
    targetChannelId: targetIsConnected ? target.channelId : '',
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
    reasoningEffort: row.reasoningEffort,
    environmentId: row.environmentId ?? '',
    ...(target.provider !== 'none'
      ? {
          targetProvider: target.provider,
          targetMode: target.mode,
          ...(target.mode === 'channel'
            ? { targetChannelId: target.channelId }
            : {}),
        }
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

export function CustomAutomationsSection({
  filter: controlledFilter,
  search: controlledSearch,
  onFilterChange,
  onSearchChange,
  toolbarLeading,
  children,
}: {
  filter?: AutomationListFilter;
  search?: string;
  onFilterChange?: (filter: AutomationListFilter) => void;
  onSearchChange?: (search: string) => void;
  toolbarLeading?: ReactNode;
  children?: ReactNode;
} = {}) {
  const { isAdmin } = useAuthorizedUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQuery = useQuery(
    trpc.automations.listCustomAutomations.queryOptions(),
  );
  const environmentsQuery = useQuery(trpc.environments.list.queryOptions());
  const slackChannelsQuery = useQuery(
    trpc.automations.listSlackChannels.queryOptions(undefined, {
      enabled: isAdmin,
    }),
  );
  const discordChannelsQuery = useQuery(
    trpc.automations.listDiscordChannels.queryOptions(undefined, {
      enabled: isAdmin,
    }),
  );
  const optionsQuery = useQuery(
    trpc.automations.getCustomAutomationOptions.queryOptions(),
  );
  const taskModelsQuery = useLaunchTaskModels();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<CustomAutomationFormState>(EMPTY_FORM);
  const [resolvedCron, setResolvedCron] = useState<string | null>(null);
  const [scheduleSummary, setScheduleSummary] = useState<string | null>(null);
  const [localFilter, setLocalFilter] = useState<AutomationListFilter>('all');
  const [localSearch, setLocalSearch] = useState('');
  const filter = controlledFilter ?? localFilter;
  const search = controlledSearch ?? localSearch;
  const setFilter = onFilterChange ?? setLocalFilter;
  const setSearch = onSearchChange ?? setLocalSearch;

  // New destinations default to the shared manager channel, matching where
  // the other automations report by default.
  const managerSlackChannelId = optionsQuery.data?.managerSlackChannelId ?? '';
  const managerDiscordChannelId =
    optionsQuery.data?.managerDiscordChannelId ?? '';
  const capabilities = optionsQuery.data?.capabilities;
  const capabilitiesLoaded = !optionsQuery.isPending && Boolean(capabilities);
  const connectedDestinationOptions = useMemo(
    () =>
      capabilitiesLoaded
        ? DESTINATION_OPTIONS.filter(
            (option) => capabilities?.[option.capability] === true,
          )
        : [],
    [capabilities, capabilitiesLoaded],
  );
  const connectedDestinationProviders = useMemo(
    () => connectedDestinationOptions.map((option) => option.value),
    [connectedDestinationOptions],
  );
  const capabilitiesLoadedRef = useRef(capabilitiesLoaded);
  const connectedDestinationProvidersRef = useRef(
    connectedDestinationProviders,
  );
  capabilitiesLoadedRef.current = capabilitiesLoaded;
  connectedDestinationProvidersRef.current = connectedDestinationProviders;

  const environmentOptions = useMemo(
    () => [
      { id: FAST_EXECUTION, name: 'Let Roomote decide' },
      { id: ALL_REPOSITORIES, name: 'All repositories' },
      { id: NO_REPOSITORIES, name: 'Blank slate' },
      ...(environmentsQuery.data ?? []).map((environment) => ({
        id: environment.id,
        name: environment.name,
      })),
    ],
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
  const schedulingTimeZone = optionsQuery.data?.effectiveTimeZone;
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
  const normalizedSearch = search.trim().toLowerCase();
  const visibleRows =
    filter === 'built-in'
      ? []
      : rows.filter((row) => {
          const target = targetFromRow(row);
          const environmentName =
            row.executionMode === 'fast'
              ? ''
              : (environmentOptions.find(
                  (environment) => environment.id === row.environmentId,
                )?.name ?? 'Environment missing');
          const destinationName =
            DESTINATION_OPTIONS.find(
              (option) => option.value === target.provider,
            )?.label ?? 'No report channel';
          const destinationLabel =
            target.provider === 'slack'
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
            !normalizedSearch ||
            [
              row.name,
              row.prompt,
              cadenceLabel(row),
              environmentName,
              destinationName,
              destinationLabel,
              row.createdByName ?? '',
              row.latestFastResult ?? '',
            ]
              .join(' ')
              .toLowerCase()
              .includes(normalizedSearch)
          );
        });
  const atCap = rows.length >= MAX_CUSTOM_AUTOMATIONS;
  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    toggleMutation.isPending;
  const selectedModel = taskModelsQuery.data?.models.find(
    (model) => model.id === form.model,
  );
  const selectedModelSupportsReasoning = Boolean(
    selectedModel && selectedModel.metadata?.supportsReasoning !== false,
  );

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
    setForm(
      formFromRow(
        row,
        capabilitiesLoaded ? connectedDestinationProviders : null,
      ),
    );
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
        setForm(
          formFromRow(
            row,
            capabilitiesLoadedRef.current
              ? connectedDestinationProvidersRef.current
              : null,
          ),
        );
        setResolvedCron(row.cronExpression ?? null);
        setScheduleSummary(null);
      }
    };

    openLinkedAutomation();
    window.addEventListener('hashchange', openLinkedAutomation);
    return () => window.removeEventListener('hashchange', openLinkedAutomation);
  }, [rows]);

  useEffect(() => {
    if (!capabilitiesLoaded) return;

    setForm((current) =>
      current.targetProvider === 'none' ||
      connectedDestinationProviders.includes(current.targetProvider)
        ? current
        : {
            ...current,
            targetProvider: 'none',
            targetMode: 'channel',
            targetChannelId: '',
          },
    );
  }, [capabilitiesLoaded, connectedDestinationProviders]);

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
    if (
      form.targetProvider !== 'none' &&
      form.targetMode === 'channel' &&
      !form.targetChannelId.trim()
    ) {
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
      reasoningEffort: form.model ? form.reasoningEffort : null,
      environmentId: form.environmentId,
      ...(form.targetProvider !== 'none'
        ? {
            targetProvider: form.targetProvider,
            targetMode: form.targetMode,
            ...(form.targetMode === 'channel'
              ? { targetChannelId: form.targetChannelId }
              : {}),
          }
        : {}),
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
      return;
    }

    createMutation.mutate(payload);
  };

  const renderEditor = () => (
    <DialogContent size="4xl" aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>
          {editingId ? 'Edit custom automation' : 'New custom automation'}
        </DialogTitle>
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

        <div className="space-y-2">
          <Label htmlFor="custom-automation-schedule">Schedule</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
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
              <SelectTrigger
                id="custom-automation-schedule"
                className="w-full sm:w-52"
              >
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

            {form.scheduleMode === 'cron' ? (
              <Input
                id="custom-automation-cron"
                aria-label="Custom schedule"
                className="flex-1"
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
            ) : null}
          </div>
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

        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="space-y-2 sm:w-52">
            <Label htmlFor="custom-automation-environment">
              Preferred environment
            </Label>
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
              <SelectTrigger
                id="custom-automation-environment"
                className="w-full"
              >
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

          <div className="min-w-0 flex-1 space-y-2">
            <Label>Delegated task model</Label>
            <ModelSelect
              size="default"
              ariaLabel="Automation model"
              value={form.model}
              emptyOptionLabel="Default delegated task model"
              className="w-full"
              disabled={busy}
              onValueChange={(value) => {
                const nextModel = taskModelsQuery.data?.models.find(
                  (model) => model.id === value,
                );
                const supportsReasoning = Boolean(
                  nextModel && nextModel.metadata?.supportsReasoning !== false,
                );
                setForm((current) => ({
                  ...current,
                  model: value,
                  reasoningEffort: supportsReasoning
                    ? current.reasoningEffort
                    : null,
                }));
              }}
            />
          </div>

          <div className="space-y-2 sm:w-40">
            <Label>Effort</Label>
            <ReasoningEffortSelect
              value={form.reasoningEffort}
              defaultEffort="medium"
              emptyOptionLabel="Model default"
              ariaLabel="Automation effort"
              className="w-full"
              size="default"
              disabled={busy || !selectedModelSupportsReasoning}
              onChange={(reasoningEffort) =>
                setForm((current) => ({ ...current, reasoningEffort }))
              }
            />
          </div>
        </div>

        <div className="space-y-2">
          <AutomationDestinationPicker
            channelCatalogAvailable={isAdmin}
            id="custom-automation-destination"
            value={{
              provider: form.targetProvider,
              mode: form.targetMode,
              channelId: form.targetChannelId,
            }}
            availableProviders={connectedDestinationProviders}
            slackOptions={slackOptions}
            discordOptions={discordOptions}
            defaultSlackChannelId={managerSlackChannelId}
            defaultDiscordChannelId={managerDiscordChannelId}
            disabled={busy}
            onChange={(destination) =>
              setForm((current) => ({
                ...current,
                targetProvider: destination.provider,
                targetMode: destination.mode,
                targetChannelId: destination.channelId,
              }))
            }
          />
          <p className="text-sm text-muted-foreground">
            {form.targetProvider === 'none'
              ? 'Each run is a Session in the web app and does not post to chat.'
              : 'Each run is a Session that reports findings and failures here, and replies continue it.'}
          </p>
        </div>

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
            <Button
              type="button"
              disabled={busy || !capabilitiesLoaded}
              onClick={saveForm}
            >
              {editingId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </DialogContent>
  );

  const newButton =
    !isCreating && !editingId ? (
      <Button
        type="button"
        size="sm"
        disabled={busy || atCap || !capabilitiesLoaded}
        onClick={() => {
          const managerProvider =
            managerSlackChannelId && capabilities?.slackConnected
              ? 'slack'
              : managerDiscordChannelId && capabilities?.discordConnected
                ? 'discord'
                : null;
          const targetProvider =
            managerProvider ?? connectedDestinationOptions[0]?.value ?? 'none';
          setIsCreating(true);
          setEditingId(null);
          setForm({
            ...EMPTY_FORM,
            targetProvider,
            targetChannelId:
              targetProvider === 'slack'
                ? managerSlackChannelId
                : targetProvider === 'discord'
                  ? managerDiscordChannelId
                  : '',
          });
          setResolvedCron(null);
          setScheduleSummary(null);
        }}
      >
        <Plus />
        New
      </Button>
    ) : null;

  return (
    <section className="space-y-3" aria-label="Automations">
      <AutomationListToolbar
        filter={filter}
        search={search}
        leading={toolbarLeading}
        action={newButton}
        onFilterChange={setFilter}
        onSearchChange={setSearch}
      />

      <Dialog
        open={isCreating || Boolean(editingId)}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        {isCreating || editingId ? renderEditor() : null}
      </Dialog>

      <Card variant="snug">
        <CardContent className="p-0!">
          <div role="table" aria-label="Automations">
            <AutomationListHeader />
            <div role="rowgroup" className="divide-y divide-background">
              {listQuery.isPending && filter !== 'built-in' ? (
                <div data-testid="custom-automations-skeleton">
                  {Array.from({ length: 2 }).map((_, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-3 px-4 py-3"
                    >
                      <Skeleton className="mt-0.5 h-5 w-9 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-full max-w-lg" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {!listQuery.isPending &&
              visibleRows.length === 0 &&
              filter === 'custom' ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  {normalizedSearch
                    ? 'No custom automations match your search.'
                    : 'No custom automations created yet.'}
                </p>
              ) : null}
              {visibleRows.map((row) => {
                const environmentName =
                  row.executionMode === 'fast'
                    ? null
                    : (environmentOptions.find(
                        (environment) => environment.id === row.environmentId,
                      )?.name ?? 'Environment missing');
                const target = targetFromRow(row);
                const destinationName =
                  DESTINATION_OPTIONS.find(
                    (option) => option.value === target.provider,
                  )?.label ?? 'No report channel';
                const destinationLabel =
                  target.provider === 'none'
                    ? ''
                    : target.mode === 'direct_message'
                      ? 'DM me'
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
                  <AutomationListRow
                    key={row.id}
                    icon={Zap}
                    name={row.name}
                    description={
                      <div className="space-y-1">
                        <p>{row.prompt}</p>
                        {row.latestFastResult ? (
                          <p className="line-clamp-2 text-xs">
                            {row.latestFastResult}
                          </p>
                        ) : null}
                      </div>
                    }
                    enabledControl={
                      <Switch
                        aria-label={`Toggle ${row.name}`}
                        checked={row.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          toggleMutation.mutate({
                            id: row.id,
                            ...writeInputFromRow(row),
                            enabled,
                          })
                        }
                      />
                    }
                    summary={
                      <>
                        <span>
                          {cadenceLabel(row)}
                          {environmentName
                            ? `, in ${environmentName}`
                            : ''} →
                        </span>
                        {target.provider !== 'none' ? (
                          <BrandIcon
                            icon={target.provider}
                            name=""
                            className="size-4 shrink-0"
                          />
                        ) : null}
                        <span>
                          {destinationName}
                          {destinationLabel ? ` ${destinationLabel}` : ''}
                        </span>
                        <span>
                          Created by {row.createdByName ?? 'Unknown'}
                          {row.lastRunAt ? (
                            <>
                              {' · Last run '}
                              <span
                                title={new Date(row.lastRunAt).toLocaleString()}
                              >
                                {formatDistanceToNowCompact(
                                  new Date(row.lastRunAt),
                                  { addSuffix: true },
                                )}
                              </span>
                            </>
                          ) : null}
                        </span>
                      </>
                    }
                    actions={
                      <>
                        <CustomAutomationRunButton
                          automation={row}
                          disabled={busy}
                        />
                        <BasicTooltip content="Configure">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Configure ${row.name}`}
                            onClick={() => editAutomation(row)}
                          >
                            <Settings2 />
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
                      </>
                    }
                  />
                );
              })}
              {filter !== 'custom' ? children : null}
              {!listQuery.isPending &&
              visibleRows.length === 0 &&
              !children &&
              (filter !== 'custom' || normalizedSearch) ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  No automations match your filters.
                </p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
