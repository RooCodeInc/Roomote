import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type BackgroundAutomationKey,
  type AutomationResultPriority,
} from '@roomote/types';
import { eq } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { automationResults, customAutomations, tasks } from '../schema';

export async function recordAutomationResultForTask(
  params: { taskId: string; content: string; dedupeKey: string },
  client: DatabaseOrTransaction = db,
) {
  const task = await client.query.tasks.findFirst({
    where: eq(tasks.id, params.taskId),
    columns: {
      initiatorAutomation: true,
      initiatorUserId: true,
      actorExternalId: true,
      actorDisplayName: true,
    },
  });

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

  return result ?? null;
}

export async function recordCustomAutomationResult(
  params: {
    automationId: string;
    userId: string;
    content: string;
    dedupeKey: string;
    priority?: AutomationResultPriority;
  },
  client: DatabaseOrTransaction = db,
) {
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
      userId: params.userId,
      automationName: automation.name,
      content: params.content,
      priority: params.priority ?? automation.resultPriority,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();

  return result ?? null;
}

export async function recordBackgroundAutomationResult(
  params: {
    automationKey: Parameters<
      typeof getTriggerableBackgroundAutomationDescriptorByKey
    >[0];
    content: string;
    dedupeKey: string;
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
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: automationResults.dedupeKey })
    .returning();
  return result ?? null;
}

export async function recordSuggestionResults(
  suggestions: Array<{
    workItemId: string;
    automationKey: BackgroundAutomationKey | null;
    customAutomationId?: string | null;
    sourceTaskId?: string | null;
    userId: string | null;
    automationName: string;
    title: string;
    content: string;
    priority: AutomationResultPriority;
    createdAt?: Date;
  }>,
  client: DatabaseOrTransaction = db,
) {
  if (suggestions.length === 0) return [];

  return client
    .insert(automationResults)
    .values(
      suggestions.map((suggestion) => ({
        automationKey: suggestion.automationKey,
        customAutomationId: suggestion.customAutomationId ?? null,
        sourceTaskId: suggestion.sourceTaskId ?? null,
        sourceWorkItemId: suggestion.workItemId,
        userId: suggestion.userId,
        kind: 'suggestion' as const,
        automationName: suggestion.automationName,
        title: suggestion.title,
        content: suggestion.content,
        priority: suggestion.priority,
        dedupeKey: `work-item:${suggestion.workItemId}`,
        ...(suggestion.createdAt ? { createdAt: suggestion.createdAt } : {}),
      })),
    )
    .onConflictDoNothing({ target: automationResults.sourceWorkItemId })
    .returning();
}
