import { db, ensureAutomationRows, eq, taskRuns } from '@roomote/db/server';
import { ALL_REPOSITORIES, RunStatus, TaskPayloadKind } from '@roomote/types';

import { enqueueTask } from './task-run-queue';

const timeoutMs = Number(process.env.DEPLOYMENT_CI_TASK_TIMEOUT_MS ?? 90_000);

await ensureAutomationRows();

const run = await enqueueTask(
  {
    task: {
      type: TaskPayloadKind.StandardTask,
      computeProvider: 'docker',
      requestedWorkKindDecision: {
        kind: 'question',
        source: 'explicit_bootstrap',
        confidence: null,
      },
      payload: {
        repo: ALL_REPOSITORIES,
        description:
          'Deployment CI probe. Start the Docker task sandbox and then exit.',
      },
    },
    initiator: { kind: 'automation', key: 'suggester' },
    workflow: 'standard',
    surface: 'api',
    trigger: 'manual',
    visibility: 'hidden',
  },
  { skipEarlyTitleGeneration: true },
);

const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  const current = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, run.id),
    columns: {
      id: true,
      machineId: true,
      vendor: true,
      status: true,
      error: true,
    },
  });

  if (current?.machineId && current.vendor === 'docker') {
    console.log(JSON.stringify(current));
    process.exit(0);
  }

  if (
    current?.status === RunStatus.Failed ||
    current?.status === RunStatus.Canceled
  ) {
    throw new Error(
      `Docker task ${run.id} failed before a sandbox was launched: ${current.error ?? current.status}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

throw new Error(
  `Timed out after ${timeoutMs}ms waiting for Docker task ${run.id} to launch`,
);
