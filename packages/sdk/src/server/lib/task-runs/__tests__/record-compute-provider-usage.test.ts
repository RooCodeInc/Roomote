import {
  runFactory,
  computeProviderUsage,
  computeProviderUsageSamples,
  db,
  eq,
  taskFactory,
  tasks,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import { recordComputeProviderUsage } from '../record-compute-provider-usage';

describe('recordComputeProviderUsage', () => {
  it('inserts a compute_provider_usage row for a hosted task run and syncs task compute rollups', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-1',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T12:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T12:05:00.000Z'),
      activeCpuDurationMs: 120_000,
      networkIngressBytes: 1_000,
      networkEgressBytes: 2_000,
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'modal',
      providerUsageId: `roomote:compute:modal:${taskRun.id}:sb-usage-1`,
      authKind: 'task_run',
      runId: taskRun.id,
      taskId: task.id,
      instanceId: 'sb-usage-1',
      launchMode: 'fresh',
      lifecycleAction: 'destroy',
      measurementSource: 'modal_requested_resources',
      wallClockDurationMs: 300_000,
      activeCpuDurationMs: 120_000,
      networkIngressBytes: 1_000,
      networkEgressBytes: 2_000,
      startedAt: new Date('2026-04-16T12:00:00.000Z'),
      completedAt: new Date('2026-04-16T12:05:00.000Z'),
    });
    expect(rows[0]?.details).toMatchObject({
      usageWindowStartedAtSource: 'provisionStartedAt',
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 300_000,
    });
  });

  it('upserts duplicate compute usage rows instead of double-counting the task rollups', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-2',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T13:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T13:05:00.000Z'),
      activeCpuDurationMs: 120_000,
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T13:06:00.000Z'),
      activeCpuDurationMs: 180_000,
      networkIngressBytes: 4_000,
      networkEgressBytes: 4_000,
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wallClockDurationMs: 360_000,
      activeCpuDurationMs: 180_000,
      networkIngressBytes: 4_000,
      networkEgressBytes: 4_000,
      completedAt: new Date('2026-04-16T13:06:00.000Z'),
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 360_000,
    });
  });

  it('lets a final teardown update replace an earlier running estimate for the same usage row', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-3',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T14:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T14:05:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'snapshot',
      completedAt: new Date('2026-04-16T14:10:00.000Z'),
      activeCpuDurationMs: 150_000,
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerUsageId: `roomote:compute:modal:${taskRun.id}:sb-usage-3`,
      lifecycleAction: 'snapshot',
      wallClockDurationMs: 600_000,
      activeCpuDurationMs: 150_000,
    });
  });

  it('does not recompute task rollups for provisional running updates', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-rollup-running',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T14:30:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T14:35:00.000Z'),
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 0,
    });
  });

  it('does not let a later running estimate overwrite a final teardown update', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-4',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T15:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
      activeCpuDurationMs: 160_000,
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:11:00.000Z'),
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerUsageId: `roomote:compute:modal:${taskRun.id}:sb-usage-4`,
      lifecycleAction: 'destroy',
      wallClockDurationMs: 600_000,
      activeCpuDurationMs: 160_000,
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
    });
  });

  it('lets a final teardown update replace a later running estimate for the same usage row', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-4b',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T15:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:11:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
      activeCpuDurationMs: 160_000,
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerUsageId: `roomote:compute:modal:${taskRun.id}:sb-usage-4b`,
      lifecycleAction: 'destroy',
      wallClockDurationMs: 600_000,
      activeCpuDurationMs: 160_000,
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 600_000,
    });
  });

  it('persists cgroup samples on running updates without summarizing them yet', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-running-sample-1',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T15:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:02:00.000Z'),
      sampledCpuUsageNsTotal: 120_000_000_000,
      sampledMemoryUsageBytes: 2_147_483_648,
      sampledMemoryPeakUsageBytes: 2_147_483_648,
      details: {
        updateKind: 'periodic',
      },
    });

    const usageRows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      provider: 'modal',
      lifecycleAction: 'running',
      // Modal summarizes cgroup samples on every update, including periodic
      // running estimates.
      observedMemoryMibMilliseconds: 245_760_000,
    });
    expect(usageRows[0]?.details).toMatchObject({
      modalUsageSampleCount: 1,
    });

    const sampleRows = await db
      .select()
      .from(computeProviderUsageSamples)
      .where(eq(computeProviderUsageSamples.runId, taskRun.id));

    expect(sampleRows).toHaveLength(1);
    expect(sampleRows[0]?.details).toMatchObject({
      source: 'worker_modal_cgroup_poll',
      updateKind: 'periodic',
    });
  });

  it('aggregates cgroup samples into observed memory on final updates', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'sb-usage-cgroup-1',
      launchMode: 'fresh',
      provisionStartedAt: new Date('2026-04-16T15:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:02:00.000Z'),
      sampledCpuUsageNsTotal: 120_000_000_000,
      sampledMemoryUsageBytes: 2_147_483_648,
      sampledMemoryPeakUsageBytes: 2_147_483_648,
      details: {
        updateKind: 'periodic',
      },
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:04:00.000Z'),
      sampledCpuUsageNsTotal: 300_000_000_000,
      sampledMemoryUsageBytes: 3_221_225_472,
      sampledMemoryPeakUsageBytes: 4_294_967_296,
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'snapshot',
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
    });

    const usageRows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      provider: 'modal',
      measurementSource: 'modal_cgroup_samples',
      activeCpuDurationMs: 300_000,
      observedMemoryMibMilliseconds: 1_658_880_000,
      wallClockDurationMs: 600_000,
    });
    expect(usageRows[0]?.details).toMatchObject({
      modalUsageSampleCount: 2,
      modalPeakMemoryUsageBytes: 4_294_967_296,
    });

    const sampleRows = await db
      .select()
      .from(computeProviderUsageSamples)
      .where(eq(computeProviderUsageSamples.runId, taskRun.id));

    expect(sampleRows).toHaveLength(2);
    expect(sampleRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'modal',
          details: expect.objectContaining({
            source: 'worker_modal_cgroup_poll',
            updateKind: 'periodic',
          }),
        }),
      ]),
    );
  });

  it('records modal compute usage from the provision-time requested resources snapshot', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'mo-usage-1',
      launchMode: 'task_snapshot',
      configuredCpuCores: 2,
      configuredMemoryMiB: 4_096,
      provisionStartedAt: new Date('2026-04-16T14:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'snapshot',
      completedAt: new Date('2026-04-16T14:10:00.000Z'),
    });

    const rows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'modal',
      measurementSource: 'modal_requested_resources',
      configuredCpuCores: 2,
      configuredMemoryMiB: 4_096,
      wallClockDurationMs: 600_000,
    });
    expect(rows[0]?.details).toMatchObject({
      usageWindowStartedAtSource: 'provisionStartedAt',
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 600_000,
    });
  });

  it('aggregates Modal cgroup samples into the final compute usage row', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const taskRun = await runFactory.create({
      payloadKind: TaskPayloadKind.StandardTask,
      actingUserId: user.id,
      taskId: task.id,
      vendor: 'modal',
      machineId: 'mo-usage-cgroup-1',
      launchMode: 'task_snapshot',
      configuredCpuCores: 0.125,
      configuredMemoryMiB: 128,
      provisionStartedAt: new Date('2026-04-16T15:00:00.000Z'),
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:02:00.000Z'),
      sampledCpuUsageNsTotal: 120_000_000_000,
      sampledMemoryUsageBytes: 2_147_483_648,
      sampledMemoryPeakUsageBytes: 2_147_483_648,
      details: {
        updateKind: 'periodic',
        modalMemoryDiagnostic: {
          reason: 'modal_memory_pressure_diagnostic',
          diagnosticTriggerReasons: ['memory_pressure_elevated'],
        },
      },
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'running',
      completedAt: new Date('2026-04-16T15:04:00.000Z'),
      sampledCpuUsageNsTotal: 300_000_000_000,
      sampledMemoryUsageBytes: 3_221_225_472,
      sampledMemoryPeakUsageBytes: 4_294_967_296,
    });

    await recordComputeProviderUsage({
      runId: taskRun.id,
      lifecycleAction: 'snapshot',
      completedAt: new Date('2026-04-16T15:10:00.000Z'),
    });

    const usageRows = await db
      .select()
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.runId, taskRun.id));

    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      provider: 'modal',
      measurementSource: 'modal_cgroup_samples',
      activeCpuDurationMs: 300_000,
      observedMemoryMibMilliseconds: 1_658_880_000,
      wallClockDurationMs: 600_000,
    });
    expect(usageRows[0]?.details).toMatchObject({
      modalUsageSampleCount: 2,
      modalPeakMemoryUsageBytes: 4_294_967_296,
    });

    const sampleRows = await db
      .select()
      .from(computeProviderUsageSamples)
      .where(eq(computeProviderUsageSamples.runId, taskRun.id));

    expect(sampleRows).toHaveLength(2);
    expect(sampleRows[0]?.details).toMatchObject({
      source: 'worker_modal_cgroup_poll',
      updateKind: 'periodic',
      modalMemoryDiagnostic: {
        reason: 'modal_memory_pressure_diagnostic',
        diagnosticTriggerReasons: ['memory_pressure_elevated'],
      },
    });

    const [updatedTask] = await db
      .select({
        computeDurationMs: tasks.computeDurationMs,
      })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(updatedTask).toMatchObject({
      computeDurationMs: 600_000,
    });
  });

  it('keeps rows distinct when two jobs both have null machine ids', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const [taskRunA, taskRunB] = await Promise.all([
      runFactory.create({
        payloadKind: TaskPayloadKind.StandardTask,
        actingUserId: user.id,
        taskId: task.id,
        vendor: 'modal',
        machineId: null,
        launchMode: 'fresh',
        provisionStartedAt: new Date('2026-04-16T16:00:00.000Z'),
      }),
      runFactory.create({
        payloadKind: TaskPayloadKind.StandardTask,
        actingUserId: user.id,
        taskId: task.id,
        vendor: 'modal',
        machineId: null,
        launchMode: 'fresh',
        provisionStartedAt: new Date('2026-04-16T17:00:00.000Z'),
      }),
    ]);

    await recordComputeProviderUsage({
      runId: taskRunA.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T16:05:00.000Z'),
    });
    await recordComputeProviderUsage({
      runId: taskRunB.id,
      lifecycleAction: 'destroy',
      completedAt: new Date('2026-04-16T17:05:00.000Z'),
    });

    const rows = await db
      .select({
        providerUsageId: computeProviderUsage.providerUsageId,
        runId: computeProviderUsage.runId,
      })
      .from(computeProviderUsage)
      .where(eq(computeProviderUsage.taskId, task.id));

    expect(rows).toEqual(
      expect.arrayContaining([
        {
          providerUsageId: `roomote:compute:modal:${taskRunA.id}:unknown-instance`,
          runId: taskRunA.id,
        },
        {
          providerUsageId: `roomote:compute:modal:${taskRunB.id}:unknown-instance`,
          runId: taskRunB.id,
        },
      ]),
    );
  });
});
