import {
  type ComputeProvider,
  RunStatus,
  computeProviderUsageFinalLifecycleActions,
} from '@roomote/types';
import {
  and,
  computeProviderUsage,
  createComputeProviderMutationEventRecorder,
  db,
  eq,
  inArray,
  resolveComputeProviderEnvValues,
  taskRuns,
} from '@roomote/db/server';
import { createComputeProviderClient } from '@roomote/compute-providers';

import {
  claimMachineDestroy,
  releaseMachineDestroyClaim,
} from './machine-destroy-claim';
import { recordComputeProviderUsage } from './record-compute-provider-usage';

type DestroyCanceledTaskRunSandboxResult = 'destroyed' | 'skipped' | 'failed';

async function createCancelTeardownClient(provider: ComputeProvider) {
  // Docker resolves purely from the local daemon; every managed provider
  // falls back to the encrypted deployment env vars saved during setup.
  return provider === 'docker'
    ? createComputeProviderClient({ provider })
    : createComputeProviderClient({
        provider,
        envFallback: await resolveComputeProviderEnvValues(provider),
      });
}

/**
 * Best-effort teardown of a canceled run's live sandbox.
 *
 * Canceled runs never re-enter the sleep/snapshot pipeline (sleep-check only
 * sweeps active statuses), so a machine that is still attached when the run
 * turns terminal would otherwise keep running — and keep counting against the
 * provider's sandbox capacity — until the provider TTL reaps it. Every path
 * that finalizes a run as canceled funnels through this helper.
 *
 * Skips when the run has no machine, was preserved via snapshot, is not
 * actually canceled, or already has a final `compute_provider_usage` record
 * (a prior destroy/snapshot — e.g. sleep-check destroyed the instance before
 * calling finishRun). Never throws: cancel finalization must not fail because
 * provider teardown did.
 */
export async function destroyCanceledTaskRunSandbox(params: {
  runId: number;
  /** Caller tag used for log lines and the recorded audit trail. */
  logPrefix: string;
}): Promise<DestroyCanceledTaskRunSandboxResult> {
  const { runId, logPrefix } = params;

  try {
    const run = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: {
        id: true,
        taskId: true,
        status: true,
        machineId: true,
        vendor: true,
        snapshotId: true,
        canceledAt: true,
      },
    });

    if (
      !run ||
      !run.machineId ||
      run.snapshotId != null ||
      (run.status !== RunStatus.Canceled && run.canceledAt == null)
    ) {
      return 'skipped';
    }

    // A final lifecycle record means the instance was already torn down (or
    // preserved) by another writer — most commonly sleep-check destroying the
    // machine right before it finalizes the run as canceled.
    const [finalUsageRecord] = await db
      .select({ id: computeProviderUsage.id })
      .from(computeProviderUsage)
      .where(
        and(
          eq(computeProviderUsage.runId, runId),
          inArray(computeProviderUsage.lifecycleAction, [
            ...computeProviderUsageFinalLifecycleActions,
          ]),
        ),
      )
      .limit(1);

    if (finalUsageRecord) {
      return 'skipped';
    }

    const provider: ComputeProvider = run.vendor ?? 'docker';

    // The usage-record check above is only a fast path; it cannot arbitrate a
    // live race because every destroyer records usage after the provider call
    // returns. The redis claim is the atomic gate: exactly one caller owns the
    // provider delete for this machine.
    const claim = await claimMachineDestroy({
      provider,
      machineId: run.machineId,
      owner: logPrefix,
    });

    if (claim === 'held') {
      console.log(
        `[${logPrefix}] Skipping sandbox teardown for canceled task run #${run.id}: another destroyer holds the claim for ${run.machineId}`,
      );
      return 'skipped';
    }

    const client = await createCancelTeardownClient(provider);

    const recordMutation = createComputeProviderMutationEventRecorder(
      db,
      {
        runId: run.id,
        taskId: run.taskId,
      },
      { logPrefix, logger: console },
    );

    const details = {
      phase: 'destroy_after_cancel',
      reason: 'task_run_canceled',
      trigger: logPrefix,
    };

    await recordMutation({
      provider,
      operation: 'destroy_instance',
      eventType: 'started',
      instanceId: run.machineId,
      message: `Calling destroyInstance for instance ${run.machineId} of canceled task run #${run.id}.`,
      details,
    });

    let usageObservation;

    try {
      ({ usageObservation } = await client.destroyInstance({
        instanceId: run.machineId,
      }));
    } catch (error) {
      // Give the claim back so sleep-check or a later cancel path can retry.
      if (claim === 'claimed') {
        await releaseMachineDestroyClaim({
          provider,
          machineId: run.machineId,
        });
      }
      await recordMutation({
        provider,
        operation: 'destroy_instance',
        eventType: 'failed',
        instanceId: run.machineId,
        message: `destroyInstance failed for instance ${run.machineId} of canceled task run #${run.id}.`,
        details: {
          ...details,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      console.warn(
        `[${logPrefix}] Failed to destroy sandbox ${run.machineId} for canceled task run #${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'failed';
    }

    try {
      await recordComputeProviderUsage({
        runId: run.id,
        lifecycleAction: 'destroy',
        completedAt: new Date(),
        activeCpuDurationMs: usageObservation?.activeCpuDurationMs,
        networkIngressBytes: usageObservation?.networkTransfer?.ingress,
        networkEgressBytes: usageObservation?.networkTransfer?.egress,
        details: { provider, ...details },
      });
    } catch (error) {
      console.warn(
        `[${logPrefix}] Failed to record compute provider usage for canceled task run #${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await recordMutation({
      provider,
      operation: 'destroy_instance',
      eventType: 'completed',
      instanceId: run.machineId,
      message: `destroyInstance completed for instance ${run.machineId} of canceled task run #${run.id}.`,
      details,
    });

    console.log(
      `[${logPrefix}] Destroyed sandbox ${run.machineId} for canceled task run #${run.id}`,
    );

    return 'destroyed';
  } catch (error) {
    console.warn(
      `[${logPrefix}] Failed to tear down sandbox for canceled task run #${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
}
