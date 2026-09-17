import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type AutomationResultPriority,
  type AutomationResultVisibility,
} from '@roomote/types';
import { and, eq, isNull } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import {
  automationResults,
  customAutomations,
  taskPullRequests,
  tasks,
} from '../schema';

export async function reconcileAutomationResultAcceptance(
  taskId: string,
  client: DatabaseOrTransaction = db,
): Promise<boolean> {
  const deliverablePullRequests = await client
    .select({
      mergedAt: taskPullRequests.mergedAt,
      status: taskPullRequests.status,
    })
    .from(taskPullRequests)
    .where(
      and(
        eq(taskPullRequests.taskId, taskId),
        eq(taskPullRequests.createdByRoomote, true),
      ),
    )
    .limit(2);
  const [deliverable] = deliverablePullRequests;

  if (
    deliverablePullRequests.length !== 1 ||
    deliverable?.status !== 'merged' ||
    !deliverable.mergedAt
  ) {
    return false;
  }

  const accepted = await client
    .update(automationResults)
    .set({
      acceptedAt: deliverable.mergedAt,
      acceptanceReason: 'pull_request_merged',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationResults.sourceTaskId, taskId),
        isNull(automationResults.acceptedAt),
        isNull(automationResults.ignoredAt),
      ),
    )
    .returning({ id: automationResults.id });

  return accepted.length > 0;
}

async function recordAutomationResultForTaskWithClient(
  params: {
    taskId: string;
    content: string;
    dedupeKey: string;
    visibility: AutomationResultVisibility;
  },
  client: DatabaseOrTransaction,
) {
  const [task] = await client
    .select({
      initiatorAutomation: tasks.initiatorAutomation,
      initiatorUserId: tasks.initiatorUserId,
      actorExternalId: tasks.actorExternalId,
      actorDisplayName: tasks.actorDisplayName,
    })
    .from(tasks)
    .where(eq(tasks.id, params.taskId))
    .for('update');

  if (!task?.initiatorAutomation) return null;

  const customAutomation =
    task.initiatorAutomation === 'custom_automation' && task.actorExternalId
      ? await client.query.customAutomations.findFirst({
          where: eq(customAutomations.id, task.actorExternalId),
          columns: {
            id: true,
            name: true,
            resultPriority: true,
            createdByUserId: true,
          },
        })
      : null;
  const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
    task.initiatorAutomation,
  );

  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: task.initiatorAutomation,
      customAutomationId: customAutomation?.id ?? null,
      sourceTaskId: params.taskId,
      userId: customAutomation?.createdByUserId ?? task.initiatorUserId,
      resultVisibility: params.visibility,
      automationName:
        customAutomation?.name ??
        task.actorDisplayName ??
        descriptor?.label ??
        'Automation',
      content: params.content,
      priority:
        customAutomation?.resultPriority ??
        (descriptor && 'resultPriority' in descriptor
          ? descriptor.resultPriority
          : 'normal'),
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();

  await reconcileAutomationResultAcceptance(params.taskId, client);

  return result ?? null;
}

export async function recordAutomationResultForTask(
  params: {
    taskId: string;
    content: string;
    dedupeKey: string;
    visibility: AutomationResultVisibility;
  },
  client: DatabaseOrTransaction = db,
) {
  if (client === db) {
    return db.transaction((tx) =>
      recordAutomationResultForTaskWithClient(params, tx),
    );
  }

  return recordAutomationResultForTaskWithClient(params, client);
}

async function recordCustomAutomationResultWithClient(
  params: {
    automationId: string;
    userId: string;
    sourceTaskId?: string;
    content: string;
    dedupeKey: string;
    priority?: AutomationResultPriority;
    visibility: AutomationResultVisibility;
  },
  client: DatabaseOrTransaction,
) {
  if (params.sourceTaskId) {
    await client
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, params.sourceTaskId))
      .for('update');
  }

  const automation = await client.query.customAutomations.findFirst({
    where: eq(customAutomations.id, params.automationId),
    columns: { id: true, name: true, resultPriority: true },
  });
  if (!automation) return null;

  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: 'custom_automation',
      customAutomationId: automation.id,
      sourceTaskId: params.sourceTaskId,
      userId: params.userId,
      resultVisibility: params.visibility,
      automationName: automation.name,
      content: params.content,
      priority: params.priority ?? automation.resultPriority,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();

  if (params.sourceTaskId) {
    await reconcileAutomationResultAcceptance(params.sourceTaskId, client);
  }

  return result ?? null;
}

export async function recordBackgroundAutomationResult(
  params: {
    automationKey: Parameters<
      typeof getTriggerableBackgroundAutomationDescriptorByKey
    >[0];
    content: string;
    dedupeKey: string;
    visibility: AutomationResultVisibility;
  },
  client: DatabaseOrTransaction = db,
) {
  const descriptor = getTriggerableBackgroundAutomationDescriptorByKey(
    params.automationKey,
  );
  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: params.automationKey,
      automationName: descriptor?.label ?? 'Automation',
      content: params.content,
      priority:
        descriptor && 'resultPriority' in descriptor
          ? descriptor.resultPriority
          : 'normal',
      resultVisibility: params.visibility,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();

  return result ?? null;
}

export async function recordCustomAutomationResult(
  params: {
    automationId: string;
    userId: string;
    sourceTaskId?: string;
    content: string;
    dedupeKey: string;
    priority?: AutomationResultPriority;
    visibility: AutomationResultVisibility;
  },
  client: DatabaseOrTransaction = db,
) {
  if (client === db && params.sourceTaskId) {
    return db.transaction((tx) =>
      recordCustomAutomationResultWithClient(params, tx),
    );
  }

  return recordCustomAutomationResultWithClient(params, client);
}
