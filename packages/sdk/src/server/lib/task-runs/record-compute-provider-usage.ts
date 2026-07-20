import {
  type ComputeProvider,
  type ComputeProviderLaunchMode,
  type ComputeProviderUsageLifecycleAction,
  type ComputeProviderUsageMeasurementSource,
  computeProviderUsageFinalLifecycleActions,
  resolveConfiguredComputeProviderResources,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  type SQL,
  computeProviderUsage,
  db,
  eq,
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';

import {
  recordComputeProviderUsageSample,
  summarizeComputeProviderUsageSamples,
} from './compute-provider-usage-samples';

interface RecordComputeProviderUsageInput {
  runId: number;
  lifecycleAction: ComputeProviderUsageLifecycleAction;
  completedAt?: Date | null;
  activeCpuDurationMs?: number | null;
  observedMemoryMibMilliseconds?: number | null;
  networkIngressBytes?: number | null;
  networkEgressBytes?: number | null;
  measurementSource?: ComputeProviderUsageMeasurementSource | null;
  sampledCpuUsageNsTotal?: number | null;
  sampledMemoryUsageBytes?: number | null;
  sampledMemoryPeakUsageBytes?: number | null;
  details?: Record<string, unknown> | null;
}

interface ComputeProviderUsageTaskRun {
  id: number;
  taskId: string | null;
  machineId: string | null;
  launchMode: ComputeProviderLaunchMode | null;
  provisionStartedAt: Date | null;
}

interface ComputeProviderUsageTaskRunRecord extends ComputeProviderUsageTaskRun {
  vendor: ComputeProvider | null;
  configuredVcpus: number | null;
  configuredCpuCores: number | null;
  configuredMemoryMiB: number | null;
  startedAt: Date | null;
  createdAt: Date;
}

interface ProviderUsageContext {
  taskRun: ComputeProviderUsageTaskRun;
  input: RecordComputeProviderUsageInput;
  providerUsageId: string;
  startedAt: Date;
  completedAt: Date;
  inputActiveCpuDurationMs: number | null;
  inputObservedMemoryMibMilliseconds: number | null;
}

interface ProviderUsageDerivation {
  activeCpuDurationMs: number | null;
  observedMemoryMibMilliseconds: number | null;
  detailPatch: Record<string, unknown>;
  preferredMeasurementSource: ComputeProviderUsageMeasurementSource | null;
}

interface ComputeProviderUsagePolicy {
  deriveUsage(context: ProviderUsageContext): Promise<ProviderUsageDerivation>;
}

type ComputeProviderUsageStartedAtSource =
  | 'provisionStartedAt'
  | 'startedAt'
  | 'createdAt';

type ComputeProviderUsageResources = ReturnType<
  typeof resolveConfiguredResources
>;

type ComputeProviderUsageInsert = typeof computeProviderUsage.$inferInsert;

interface LoadedComputeProviderUsageContext {
  taskRun: ComputeProviderUsageTaskRunRecord;
  provider: ComputeProvider;
  providerUsageId: string;
  completedAt: Date;
  startedAt: Date;
  startedAtSource: ComputeProviderUsageStartedAtSource;
  wallClockDurationMs: number;
  resources: ComputeProviderUsageResources;
  inputActiveCpuDurationMs: number | null;
  inputObservedMemoryMibMilliseconds: number | null;
  networkIngressBytes: number | null;
  networkEgressBytes: number | null;
}

function clampOptionalInteger(value: number | null | undefined): number | null {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, Math.trunc(numericValue));
}

function clampOptionalNumber(value: number | null | undefined): number | null {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, numericValue);
}

function normalizeDetails(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return input ? { ...input } : {};
}

function buildComputeProviderUsageId(input: {
  provider: ComputeProvider;
  runId: number;
  instanceId: string | null;
}): string {
  return [
    'roomote',
    'compute',
    input.provider,
    String(input.runId),
    input.instanceId ?? 'unknown-instance',
  ].join(':');
}

function isFinalLifecycleAction(
  lifecycleAction: ComputeProviderUsageLifecycleAction,
): boolean {
  return (
    computeProviderUsageFinalLifecycleActions as readonly ComputeProviderUsageLifecycleAction[]
  ).includes(lifecycleAction);
}

function resolveConfiguredResources(input: {
  provider: ComputeProvider;
  configuredVcpus: number | null;
  configuredCpuCores: number | null;
  configuredMemoryMiB: number | null;
}): {
  configuredVcpus: number | null;
  configuredCpuCores: number | null;
  configuredMemoryMiB: number | null;
} {
  return resolveConfiguredComputeProviderResources({
    provider: input.provider,
    configuredVcpus: input.configuredVcpus,
    configuredCpuCores: input.configuredCpuCores,
    configuredMemoryMiB: input.configuredMemoryMiB,
  });
}

function hasComputeProviderUsageSampleInput(
  input: RecordComputeProviderUsageInput,
): boolean {
  return (
    input.sampledCpuUsageNsTotal !== undefined ||
    input.sampledMemoryUsageBytes !== undefined ||
    input.sampledMemoryPeakUsageBytes !== undefined
  );
}

async function recordComputeProviderUsageSampleIfPresent(input: {
  context: ProviderUsageContext;
  provider: ComputeProvider;
  source: string;
}): Promise<void> {
  const { context, provider, source } = input;

  if (!hasComputeProviderUsageSampleInput(context.input)) {
    return;
  }

  await recordComputeProviderUsageSample({
    provider,
    providerUsageId: context.providerUsageId,
    runId: context.taskRun.id,
    taskId: context.taskRun.taskId,
    instanceId: context.taskRun.machineId,
    sampledAt: context.completedAt,
    cpuUsageNsTotal: context.input.sampledCpuUsageNsTotal,
    memoryUsageBytes: context.input.sampledMemoryUsageBytes,
    memoryPeakUsageBytes: context.input.sampledMemoryPeakUsageBytes,
    details: {
      ...(context.input.details ?? {}),
      source,
    },
  });
}

async function recordModalUsageSample(
  context: ProviderUsageContext,
): Promise<void> {
  await recordComputeProviderUsageSampleIfPresent({
    context,
    provider: 'modal',
    source: 'worker_modal_cgroup_poll',
  });
}

const computeProviderUsagePolicies: Record<
  ComputeProvider,
  ComputeProviderUsagePolicy
> = {
  roomote: {
    async deriveUsage(context) {
      await recordComputeProviderUsageSampleIfPresent({
        context,
        provider: 'roomote',
        source: 'worker_roomote_cloud_cgroup_poll',
      });

      return {
        activeCpuDurationMs: context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: { managedCloudRuntime: true },
        preferredMeasurementSource: 'roomote_observation',
      };
    },
  },
  modal: {
    async deriveUsage(context) {
      await recordModalUsageSample(context);

      const sampleSummary = await summarizeComputeProviderUsageSamples({
        provider: 'modal',
        providerUsageId: context.providerUsageId,
        startedAt: context.startedAt,
        completedAt: context.completedAt,
      });

      return {
        activeCpuDurationMs:
          sampleSummary.activeCpuDurationMs ?? context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          sampleSummary.observedMemoryMibMilliseconds ??
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: {
          modalUsageSampleCount: sampleSummary.sampleCount,
          modalUsageLastSampledAt:
            sampleSummary.lastSampledAt?.toISOString() ?? null,
          modalPeakMemoryUsageBytes: sampleSummary.peakMemoryUsageBytes,
        },
        preferredMeasurementSource:
          sampleSummary.sampleCount > 0
            ? 'modal_cgroup_samples'
            : 'modal_requested_resources',
      };
    },
  },
  docker: {
    async deriveUsage(context) {
      await recordComputeProviderUsageSampleIfPresent({
        context,
        provider: 'docker',
        source: 'worker_docker_local_poll',
      });

      return {
        activeCpuDurationMs: context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: {
          localDockerRuntime: true,
        },
        preferredMeasurementSource: 'roomote_observation',
      };
    },
  },
  daytona: {
    async deriveUsage(context) {
      await recordComputeProviderUsageSampleIfPresent({
        context,
        provider: 'daytona',
        source: 'worker_daytona_cgroup_poll',
      });

      return {
        activeCpuDurationMs: context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: {},
        preferredMeasurementSource: 'roomote_observation',
      };
    },
  },
  e2b: {
    async deriveUsage(context) {
      await recordComputeProviderUsageSampleIfPresent({
        context,
        provider: 'e2b',
        source: 'worker_e2b_cgroup_poll',
      });

      return {
        activeCpuDurationMs: context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: {},
        preferredMeasurementSource: 'roomote_observation',
      };
    },
  },
  blaxel: {
    async deriveUsage(context) {
      await recordComputeProviderUsageSampleIfPresent({
        context,
        provider: 'blaxel',
        source: 'worker_blaxel_cgroup_poll',
      });

      return {
        activeCpuDurationMs: context.inputActiveCpuDurationMs,
        observedMemoryMibMilliseconds:
          context.inputObservedMemoryMibMilliseconds,
        detailPatch: {},
        preferredMeasurementSource: 'roomote_observation',
      };
    },
  },
};

function resolveMeasurementSource(input: {
  explicitMeasurementSource: ComputeProviderUsageMeasurementSource | null;
  preferredMeasurementSource: ComputeProviderUsageMeasurementSource | null;
}): ComputeProviderUsageMeasurementSource {
  return (
    input.explicitMeasurementSource ??
    input.preferredMeasurementSource ??
    'roomote_observation'
  );
}

function excludedColumn(columnName: string) {
  return sql.raw(`excluded.${columnName}`);
}

function lifecycleActionIsFinalSql(lifecycleAction: unknown): SQL<boolean> {
  return sql<boolean>`${lifecycleAction as SQL} in ('destroy', 'snapshot')`;
}

type UsageMergeMode = 'replace' | 'replaceIfPresent';

interface UsageMergeFieldConfig {
  current: unknown;
  excludedColumnName: string;
  mergeMode: UsageMergeMode;
  preferPresenceOnEqualTimestamp?: boolean;
}

const usageMergeFieldConfigs = {
  authKind: {
    current: computeProviderUsage.authKind,
    excludedColumnName: 'auth_kind',
    mergeMode: 'replace',
  },
  runId: {
    current: computeProviderUsage.runId,
    excludedColumnName: 'run_id',
    mergeMode: 'replaceIfPresent',
  },
  taskId: {
    current: computeProviderUsage.taskId,
    excludedColumnName: 'task_id',
    mergeMode: 'replaceIfPresent',
  },
  instanceId: {
    current: computeProviderUsage.instanceId,
    excludedColumnName: 'instance_id',
    mergeMode: 'replaceIfPresent',
  },
  launchMode: {
    current: computeProviderUsage.launchMode,
    excludedColumnName: 'launch_mode',
    mergeMode: 'replaceIfPresent',
  },
  lifecycleAction: {
    current: computeProviderUsage.lifecycleAction,
    excludedColumnName: 'lifecycle_action',
    mergeMode: 'replace',
  },
  measurementSource: {
    current: computeProviderUsage.measurementSource,
    excludedColumnName: 'measurement_source',
    mergeMode: 'replace',
  },
  configuredVcpus: {
    current: computeProviderUsage.configuredVcpus,
    excludedColumnName: 'configured_vcpus',
    mergeMode: 'replaceIfPresent',
  },
  configuredCpuCores: {
    current: computeProviderUsage.configuredCpuCores,
    excludedColumnName: 'configured_cpu_cores',
    mergeMode: 'replaceIfPresent',
  },
  configuredMemoryMiB: {
    current: computeProviderUsage.configuredMemoryMiB,
    excludedColumnName: 'configured_memory_mib',
    mergeMode: 'replaceIfPresent',
  },
  wallClockDurationMs: {
    current: computeProviderUsage.wallClockDurationMs,
    excludedColumnName: 'wall_clock_duration_ms',
    mergeMode: 'replace',
  },
  activeCpuDurationMs: {
    current: computeProviderUsage.activeCpuDurationMs,
    excludedColumnName: 'active_cpu_duration_ms',
    mergeMode: 'replaceIfPresent',
    preferPresenceOnEqualTimestamp: true,
  },
  observedMemoryMibMilliseconds: {
    current: computeProviderUsage.observedMemoryMibMilliseconds,
    excludedColumnName: 'observed_memory_mib_milliseconds',
    mergeMode: 'replaceIfPresent',
    preferPresenceOnEqualTimestamp: true,
  },
  networkIngressBytes: {
    current: computeProviderUsage.networkIngressBytes,
    excludedColumnName: 'network_ingress_bytes',
    mergeMode: 'replaceIfPresent',
    preferPresenceOnEqualTimestamp: true,
  },
  networkEgressBytes: {
    current: computeProviderUsage.networkEgressBytes,
    excludedColumnName: 'network_egress_bytes',
    mergeMode: 'replaceIfPresent',
    preferPresenceOnEqualTimestamp: true,
  },
  details: {
    current: computeProviderUsage.details,
    excludedColumnName: 'details',
    mergeMode: 'replace',
  },
  startedAt: {
    current: computeProviderUsage.startedAt,
    excludedColumnName: 'started_at',
    mergeMode: 'replace',
  },
  completedAt: {
    current: computeProviderUsage.completedAt,
    excludedColumnName: 'completed_at',
    mergeMode: 'replace',
  },
} satisfies Record<string, UsageMergeFieldConfig>;

type UsageMergeFieldKey = keyof typeof usageMergeFieldConfigs;

type UsageExcludedColumns = Record<UsageMergeFieldKey, SQL>;

function getUsageMergeFieldEntries(): Array<
  [UsageMergeFieldKey, (typeof usageMergeFieldConfigs)[UsageMergeFieldKey]]
> {
  return Object.entries(usageMergeFieldConfigs) as Array<
    [UsageMergeFieldKey, (typeof usageMergeFieldConfigs)[UsageMergeFieldKey]]
  >;
}

function buildUsageExcludedColumns(): UsageExcludedColumns {
  return Object.fromEntries(
    getUsageMergeFieldEntries().map(([key, config]) => [
      key,
      excludedColumn(config.excludedColumnName),
    ]),
  ) as UsageExcludedColumns;
}

function joinBooleanClauses(
  clauses: SQL<boolean>[],
  operator: 'and' | 'or',
  emptyValue: boolean,
): SQL<boolean> {
  if (clauses.length === 0) {
    return emptyValue ? sql<boolean>`true` : sql<boolean>`false`;
  }

  return sql<boolean>`(${sql.join(clauses, sql.raw(` ${operator} `))})`;
}

function mergeExcludedValue(input: {
  shouldApplyExcluded: SQL<boolean>;
  current: unknown;
  excluded: SQL;
  coalesceExcluded?: boolean;
}): SQL {
  const currentValue = input.current as SQL;

  const nextValue = input.coalesceExcluded
    ? sql`coalesce(${input.excluded}, ${currentValue})`
    : input.excluded;

  return sql`case when ${input.shouldApplyExcluded} then ${nextValue} else ${currentValue} end`;
}

function buildShouldApplyExcludedSql(input: {
  excludedColumns: UsageExcludedColumns;
}): SQL<boolean> {
  const existingLifecycleActionIsFinal = lifecycleActionIsFinalSql(
    computeProviderUsage.lifecycleAction,
  );

  const excludedLifecycleActionIsFinal = lifecycleActionIsFinalSql(
    input.excludedColumns.lifecycleAction,
  );

  const incomingFinalOverridesProvisional = sql<boolean>`(
    not ${existingLifecycleActionIsFinal}
    and ${excludedLifecycleActionIsFinal}
  )`;

  const equalTimestampPreferenceClauses: SQL<boolean>[] = [
    ...getUsageMergeFieldEntries()
      .filter(
        ([, config]) =>
          'preferPresenceOnEqualTimestamp' in config &&
          config.preferPresenceOnEqualTimestamp,
      )
      .map(([key, config]) => {
        const currentValue = config.current as unknown as SQL;

        return sql<boolean>`(
          ${input.excludedColumns[key]} is not null
          and ${currentValue} is null
        )`;
      }),
  ];

  return sql<boolean>`(
    not (
      ${existingLifecycleActionIsFinal}
      and not ${excludedLifecycleActionIsFinal}
    )
    and (
      ${incomingFinalOverridesProvisional}
      or ${input.excludedColumns.completedAt} > ${computeProviderUsage.completedAt}
      or (
        ${input.excludedColumns.completedAt} = ${computeProviderUsage.completedAt}
        and ${joinBooleanClauses(equalTimestampPreferenceClauses, 'or', false)}
      )
    )
  )`;
}

function buildUsageMergeSet(input: {
  shouldApplyExcluded: SQL<boolean>;
  excludedColumns: UsageExcludedColumns;
}) {
  return Object.fromEntries(
    getUsageMergeFieldEntries().map(([key, config]) => [
      key,
      mergeExcludedValue({
        shouldApplyExcluded: input.shouldApplyExcluded,
        current: config.current,
        excluded: input.excludedColumns[key],
        coalesceExcluded: config.mergeMode === 'replaceIfPresent',
      }),
    ]),
  ) as Record<UsageMergeFieldKey, SQL>;
}

async function recomputeTaskComputeUsageRollup(taskId: string): Promise<void> {
  const [taskUsageRollup] = await db
    .select({
      computeDurationMs: sql<number>`coalesce(sum(
        coalesce(${computeProviderUsage.wallClockDurationMs}, 0)
      ), 0)`,
    })
    .from(computeProviderUsage)
    .where(eq(computeProviderUsage.taskId, taskId));

  await db
    .update(tasks)
    .set({
      computeDurationMs: taskUsageRollup?.computeDurationMs ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}

async function loadComputeProviderUsageContext(
  input: RecordComputeProviderUsageInput,
): Promise<LoadedComputeProviderUsageContext> {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: {
      id: true,
      taskId: true,
      vendor: true,
      machineId: true,
      launchMode: true,
      configuredVcpus: true,
      configuredCpuCores: true,
      configuredMemoryMiB: true,
      provisionStartedAt: true,
      startedAt: true,
      createdAt: true,
    },
  });

  if (!taskRun) {
    throw new Error(
      `[recordComputeProviderUsage] Task run not found: ${input.runId}`,
    );
  }

  const provider = resolveComputeProviderTarget(taskRun.vendor);

  const providerUsageId = buildComputeProviderUsageId({
    provider,
    runId: taskRun.id,
    instanceId: taskRun.machineId ?? null,
  });

  const completedAt = input.completedAt ?? new Date();

  const startedAtSource: ComputeProviderUsageStartedAtSource =
    taskRun.provisionStartedAt !== null
      ? 'provisionStartedAt'
      : taskRun.startedAt !== null
        ? 'startedAt'
        : 'createdAt';

  const startedAt =
    startedAtSource === 'provisionStartedAt'
      ? taskRun.provisionStartedAt!
      : startedAtSource === 'startedAt'
        ? taskRun.startedAt!
        : taskRun.createdAt;

  return {
    taskRun,
    provider,
    providerUsageId,
    completedAt,
    startedAt,
    startedAtSource,
    wallClockDurationMs: Math.max(
      0,
      completedAt.getTime() - startedAt.getTime(),
    ),
    resources: resolveConfiguredResources({
      provider,
      configuredVcpus: taskRun.configuredVcpus ?? null,
      configuredCpuCores: taskRun.configuredCpuCores ?? null,
      configuredMemoryMiB: taskRun.configuredMemoryMiB ?? null,
    }),
    inputActiveCpuDurationMs: clampOptionalInteger(input.activeCpuDurationMs),
    inputObservedMemoryMibMilliseconds: clampOptionalInteger(
      input.observedMemoryMibMilliseconds,
    ),
    networkIngressBytes: clampOptionalInteger(input.networkIngressBytes),
    networkEgressBytes: clampOptionalInteger(input.networkEgressBytes),
  };
}

function buildComputeProviderUsageRow(input: {
  recordInput: RecordComputeProviderUsageInput;
  context: LoadedComputeProviderUsageContext;
  providerUsage: ProviderUsageDerivation;
}): ComputeProviderUsageInsert {
  const { recordInput, context, providerUsage } = input;
  const details = normalizeDetails(recordInput.details);

  details.usageWindowStartedAtSource = context.startedAtSource;
  Object.assign(details, providerUsage.detailPatch);

  return {
    provider: context.provider,
    providerUsageId: context.providerUsageId,
    authKind: 'task_run',
    runId: context.taskRun.id,
    taskId: context.taskRun.taskId ?? null,
    instanceId: context.taskRun.machineId ?? null,
    launchMode: context.taskRun.launchMode ?? null,
    lifecycleAction: recordInput.lifecycleAction,
    measurementSource: resolveMeasurementSource({
      explicitMeasurementSource: recordInput.measurementSource ?? null,
      preferredMeasurementSource: providerUsage.preferredMeasurementSource,
    }),
    configuredVcpus: context.resources.configuredVcpus,
    configuredCpuCores: clampOptionalNumber(
      context.resources.configuredCpuCores,
    ),
    configuredMemoryMiB: context.resources.configuredMemoryMiB,
    wallClockDurationMs: context.wallClockDurationMs,
    activeCpuDurationMs: providerUsage.activeCpuDurationMs,
    observedMemoryMibMilliseconds: providerUsage.observedMemoryMibMilliseconds,
    networkIngressBytes: context.networkIngressBytes,
    networkEgressBytes: context.networkEgressBytes,
    details,
    startedAt: context.startedAt,
    completedAt: context.completedAt,
  };
}

async function upsertComputeProviderUsageRow(
  row: ComputeProviderUsageInsert,
): Promise<void> {
  const excludedColumns = buildUsageExcludedColumns();
  const shouldApplyExcluded = buildShouldApplyExcludedSql({
    excludedColumns,
  });

  await db
    .insert(computeProviderUsage)
    .values(row)
    .onConflictDoUpdate({
      target: [
        computeProviderUsage.provider,
        computeProviderUsage.providerUsageId,
      ],
      set: buildUsageMergeSet({
        shouldApplyExcluded,
        excludedColumns,
      }),
    });
}

export async function recordComputeProviderUsage(
  input: RecordComputeProviderUsageInput,
): Promise<void> {
  const context = await loadComputeProviderUsageContext(input);
  const providerUsagePolicy = computeProviderUsagePolicies[context.provider];

  const providerUsage = await providerUsagePolicy.deriveUsage({
    taskRun: context.taskRun,
    input,
    providerUsageId: context.providerUsageId,
    startedAt: context.startedAt,
    completedAt: context.completedAt,
    inputActiveCpuDurationMs: context.inputActiveCpuDurationMs,
    inputObservedMemoryMibMilliseconds:
      context.inputObservedMemoryMibMilliseconds,
  });

  const row = buildComputeProviderUsageRow({
    recordInput: input,
    context,
    providerUsage,
  });

  await upsertComputeProviderUsageRow(row);

  if (
    !context.taskRun.taskId ||
    !isFinalLifecycleAction(input.lifecycleAction)
  ) {
    return;
  }

  await recomputeTaskComputeUsageRollup(context.taskRun.taskId);
}
