import { z } from 'zod';

import {
  db,
  desc,
  environmentVariables,
  eq,
  inArray,
  taskRuns,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  CONTROL_PLANE_ENV_VAR_NAMES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  isEnvVarRequestFulfillmentClientMessageId,
  isExitedRunStatus,
  deploymentEnvVarNameSchema,
} from '@roomote/types';
import { recordTaskMessageEnvelope } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

import {
  assertAdmin,
  upsertDeploymentEnvironmentVariables,
} from '../environment-variables';

export const fulfillTaskEnvVarRequestSchema = z.object({
  taskId: z.string(),
  clientMessageId: z
    .string()
    .refine(isEnvVarRequestFulfillmentClientMessageId, {
      message: 'clientMessageId must be an env-var fulfillment marker',
    }),
  names: z.array(deploymentEnvVarNameSchema).min(1).max(10),
  values: z
    .array(
      z.object({
        name: deploymentEnvVarNameSchema,
        value: z.string().max(100_000),
      }),
    )
    .max(10),
});

function sortNames(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/**
 * Persist a durable hidden fulfillment envelope so a reconnect or history
 * refetch does not resurface an already-handled env-var request. Recording is
 * idempotent on `clientMessageId`, so calling it again for the same
 * fulfillment is safe.
 */
async function recordEnvVarFulfillmentEnvelope(params: {
  runId: number;
  taskId: string;
  userId: string;
  clientMessageId: string;
}): Promise<void> {
  await recordTaskMessageEnvelope({
    runId: params.runId,
    taskId: params.taskId,
    userId: params.userId,
    envelope: {
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [],
      metadata: {
        source: 'task_env_var_request_fulfilled',
        visibleInTranscript: false,
      },
      payload: {
        clientMessageId: params.clientMessageId,
        visibleInTranscript: false,
        prompt: [],
        content: null,
      },
      visibleInTranscript: false,
    },
  });
}

export const markTaskEnvVarRequestFulfilledSchema = z.object({
  taskId: z.string(),
  clientMessageId: z
    .string()
    .refine(isEnvVarRequestFulfillmentClientMessageId, {
      message: 'clientMessageId must be an env-var fulfillment marker',
    }),
});

/**
 * Durably mark an env-var request as fulfilled for the task's active run.
 *
 * Used by the client when the follow-up prompt send fails after the variables
 * were already saved: the values persisted, but no durable fulfillment
 * envelope was recorded, so a reconnect would otherwise resurface the same
 * request. This records that envelope so the request stays dismissed.
 */
export async function markTaskEnvVarRequestFulfilledCommand(
  auth: UserAuthSuccess,
  input: z.input<typeof markTaskEnvVarRequestFulfilledSchema>,
) {
  assertAdmin(auth);

  const { taskId, clientMessageId } =
    markTaskEnvVarRequestFulfilledSchema.parse(input);

  const activeTaskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.taskId, taskId),
    orderBy: desc(taskRuns.createdAt),
    columns: { id: true },
  });

  if (!activeTaskRun) {
    return { recorded: false as const };
  }

  await recordEnvVarFulfillmentEnvelope({
    runId: activeTaskRun.id,
    taskId,
    userId: auth.userId,
    clientMessageId,
  });

  return { recorded: true as const };
}

export async function fulfillTaskEnvVarRequestCommand(
  auth: UserAuthSuccess,
  input: z.input<typeof fulfillTaskEnvVarRequestSchema>,
) {
  assertAdmin(auth);

  const { taskId, clientMessageId, names, values } =
    fulfillTaskEnvVarRequestSchema.parse(input);
  const requestedNames = sortNames(names);

  const reservedName = requestedNames.find((name) =>
    CONTROL_PLANE_ENV_VAR_NAMES.has(name),
  );
  if (reservedName) {
    throw new Error(
      `"${reservedName}" is a reserved deployment variable and cannot be requested by a task.`,
    );
  }

  if (new Set(requestedNames).size !== requestedNames.length) {
    throw new Error(
      'Requested environment variables must not contain duplicate names',
    );
  }

  const submittedNames = values.map((value) => value.name);

  if (new Set(submittedNames).size !== submittedNames.length) {
    throw new Error(
      'Submitted environment variables must not contain duplicate names',
    );
  }

  const result = await db.transaction(async (tx) => {
    const existingEnvVars = await tx
      .select({ name: environmentVariables.name })
      .from(environmentVariables)
      .where(inArray(environmentVariables.name, requestedNames));

    const existingNameSet = new Set(
      existingEnvVars.map((existingEnvVar) => existingEnvVar.name),
    );
    const requestedNameSet = new Set(requestedNames);
    const submittedValuesByName = new Map(
      values.map((value) => [value.name, value]),
    );
    const valuesToPersist: Array<{ name: string; value: string }> = [];

    for (const submittedName of submittedNames) {
      if (!requestedNameSet.has(submittedName)) {
        throw new Error(
          `${submittedName} was submitted but is not part of the request`,
        );
      }
    }

    for (const requestedName of requestedNames) {
      const submittedValue = submittedValuesByName.get(requestedName);

      if (!submittedValue || submittedValue.value.length === 0) {
        if (existingNameSet.has(requestedName)) {
          continue;
        }

        throw new Error(`Provide a value for ${requestedName}`);
      }

      valuesToPersist.push({
        name: submittedValue.name,
        value: submittedValue.value,
      });
    }

    await upsertDeploymentEnvironmentVariables(tx, {
      userId: auth.userId,
      values: valuesToPersist,
    });

    const activeTaskRun = await tx.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, taskId),
      orderBy: desc(taskRuns.createdAt),
      columns: {
        id: true,
        status: true,
        sandboxServerUrl: true,
      },
    });

    return {
      names: requestedNames,
      canReload:
        !!activeTaskRun &&
        !isExitedRunStatus(activeTaskRun.status) &&
        !!activeTaskRun.sandboxServerUrl,
      runId: activeTaskRun?.id ?? null,
    };
  });

  if (result.runId !== null && !result.canReload) {
    await recordEnvVarFulfillmentEnvelope({
      runId: result.runId,
      taskId,
      userId: auth.userId,
      clientMessageId,
    });
  }

  return result;
}
