import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type AutomationResultPriority,
  type AutomationResultKind,
  type AutomationResultVisibility,
} from '@roomote/types';
import { and, eq, isNull } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import {
  automationResults,
  customAutomations,
  sessionTasks,
  taskPullRequests,
  tasks,
} from '../schema';

function fallbackResultCopy(content: string, automationName: string) {
  const plain = content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^[#>*+\-\d.\s]+/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const firstSentence = plain.match(/^.*?(?:[.!?](?:\s|$)|$)/u)?.[0]?.trim();
  const headlineSource = firstSentence || plain || `${automationName} result`;
  const headline =
    headlineSource.length > 100
      ? `${headlineSource.slice(0, 97).trimEnd()}...`
      : headlineSource;
  const contextSource =
    plain.slice(headlineSource.length).trim() ||
    'Open the full result for the complete context.';
  const decisionContext =
    contextSource.length > 280
      ? `${contextSource.slice(0, 277).trimEnd()}...`
      : contextSource;
  return { headline, decisionContext };
}

async function getSourceSessionId(
  taskId: string,
  client: DatabaseOrTransaction,
) {
  const linked = await client.query.sessionTasks.findFirst({
    where: eq(sessionTasks.taskId, taskId),
    columns: { sessionId: true },
  });
  return linked?.sessionId ?? null;
}

async function hasTerminalResultForRun(
  runId: number,
  client: DatabaseOrTransaction,
) {
  const existing = await client.query.automationResults.findFirst({
    where: and(
      eq(automationResults.sourceRunId, runId),
      eq(automationResults.resultKind, 'outcome'),
      isNull(automationResults.supersededAt),
    ),
    columns: { id: true },
  });
  return Boolean(existing);
}

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
    sourceRunId?: number;
    resultKind?: AutomationResultKind;
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
  if (
    params.resultKind === 'input_request' &&
    params.sourceRunId &&
    (await hasTerminalResultForRun(params.sourceRunId, client))
  ) {
    return null;
  }

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
  const automationName =
    customAutomation?.name ??
    task.actorDisplayName ??
    descriptor?.label ??
    'Automation';
  const fallback = fallbackResultCopy(params.content, automationName);

  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: task.initiatorAutomation,
      customAutomationId: customAutomation?.id ?? null,
      sourceTaskId: params.taskId,
      sourceRunId: params.sourceRunId,
      sourceSessionId: await getSourceSessionId(params.taskId, client),
      userId: customAutomation?.createdByUserId ?? task.initiatorUserId,
      resultVisibility: params.visibility,
      automationName,
      content: params.content,
      resultKind: params.resultKind ?? 'outcome',
      ...fallback,
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
  if (result && params.sourceRunId && params.resultKind !== 'input_request') {
    await client
      .update(automationResults)
      .set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(automationResults.sourceRunId, params.sourceRunId),
          eq(automationResults.resultKind, 'input_request'),
          isNull(automationResults.supersededAt),
        ),
      );
  }

  return result ?? null;
}

export async function recordAutomationResultForTask(
  params: {
    taskId: string;
    content: string;
    dedupeKey: string;
    visibility: AutomationResultVisibility;
    sourceRunId?: number;
    resultKind?: AutomationResultKind;
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
    sourceRunId?: number;
    sourceSessionId?: string;
    resultKind?: AutomationResultKind;
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
  if (
    params.resultKind === 'input_request' &&
    params.sourceRunId &&
    (await hasTerminalResultForRun(params.sourceRunId, client))
  ) {
    return null;
  }

  const automation = await client.query.customAutomations.findFirst({
    where: eq(customAutomations.id, params.automationId),
    columns: { id: true, name: true, resultPriority: true },
  });
  if (!automation) return null;
  const fallback = fallbackResultCopy(params.content, automation.name);

  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: 'custom_automation',
      customAutomationId: automation.id,
      sourceTaskId: params.sourceTaskId,
      sourceRunId: params.sourceRunId,
      sourceSessionId:
        params.sourceSessionId ??
        (params.sourceTaskId
          ? await getSourceSessionId(params.sourceTaskId, client)
          : null),
      userId: params.userId,
      resultVisibility: params.visibility,
      automationName: automation.name,
      content: params.content,
      resultKind: params.resultKind ?? 'outcome',
      ...fallback,
      priority: params.priority ?? automation.resultPriority,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();

  if (params.sourceTaskId) {
    await reconcileAutomationResultAcceptance(params.sourceTaskId, client);
  }
  if (result && params.sourceRunId && params.resultKind !== 'input_request') {
    await client
      .update(automationResults)
      .set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(automationResults.sourceRunId, params.sourceRunId),
          eq(automationResults.resultKind, 'input_request'),
          isNull(automationResults.supersededAt),
        ),
      );
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
  const automationName = descriptor?.label ?? 'Automation';
  const fallback = fallbackResultCopy(params.content, automationName);
  const [result] = await client
    .insert(automationResults)
    .values({
      automationKey: params.automationKey,
      automationName,
      content: params.content,
      ...fallback,
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
    sourceRunId?: number;
    sourceSessionId?: string;
    resultKind?: AutomationResultKind;
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
