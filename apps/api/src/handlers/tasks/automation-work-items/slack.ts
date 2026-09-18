import { SlackNotifier } from '@roomote/slack';
import type { BackgroundAutomationKey } from '@roomote/types';
import {
  and,
  db,
  type DatabaseOrTransaction,
  eq,
  isNull,
  sql,
  taskRuns,
  tasks,
  upsertBackgroundAutomationSlackThread,
  workItems,
} from '@roomote/db/server';

import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { ScheduledSuggestionSlackConfig } from '../background-automation-slack.js';
import { resolveAutomationSlackTargetData } from '../automation-slack-target.js';
import type { PersistedAutomationWorkItem } from './types.js';

export async function resolveAutomationSlackTarget(params: {
  slackConfig: ScheduledSuggestionSlackConfig;
}): Promise<{
  slack: SlackNotifier;
  channelId: string;
} | null> {
  const target = await resolveAutomationSlackTargetData(
    params.slackConfig.automationKey,
  );
  if (!target || target.channelId === undefined) {
    return null;
  }

  return {
    slack: new SlackNotifier(target.slackInstallation.botAccessToken),
    channelId: target.channelId,
  };
}

async function resolveWorkItemAutomationKey(
  tx: DatabaseOrTransaction,
  automationWorkItemId: string,
): Promise<BackgroundAutomationKey | null> {
  const [automationWorkItem] = await tx
    .select({
      automationKey: workItems.automationKey,
      sourceTaskId: workItems.sourceTaskId,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, 'auto_fix'),
        eq(workItems.id, automationWorkItemId),
      ),
    )
    .limit(1);

  return automationWorkItem?.sourceTaskId
    ? (automationWorkItem.automationKey ?? null)
    : null;
}

export async function bindLateSlackThreadToTask(params: {
  taskId: string;
  channelId: string;
  threadTs: string;
  summaryText: string;
  automationWorkItemId?: string | null;
  backgroundAutomationKey?: BackgroundAutomationKey | null;
}): Promise<void> {
  const slackThreadPayloadPatch = JSON.stringify({
    channel: params.channelId,
    slackChannel: params.channelId,
    thread_ts: params.threadTs,
    slackThreadTs: params.threadTs,
  });

  await db.transaction(async (tx) => {
    // Channel bindings live on the tasks row now; only bind when no thread
    // has been bound yet (first writer wins).
    const boundTasks = await tx
      .update(tasks)
      .set({
        slackChannelId: params.channelId,
        slackThreadTs: params.threadTs,
      })
      .where(and(eq(tasks.id, params.taskId), isNull(tasks.slackThreadTs)))
      .returning({ id: tasks.id });

    // Another reply already bound a thread for this task; keep its metadata.
    if (boundTasks.length === 0) {
      return;
    }

    // Keep run payloads in sync for consumers that read Slack routing
    // metadata from the payload (prompt assembly, callbacks).
    await tx
      .update(taskRuns)
      .set({
        payload: sql`coalesce(${taskRuns.payload}, '{}'::jsonb) || ${slackThreadPayloadPatch}::jsonb`,
      })
      .where(eq(taskRuns.taskId, params.taskId));

    // A work item names the automation that queued it, which is more specific
    // than the launching automation, so it wins when both are available.
    const workItemAutomationKey = params.automationWorkItemId
      ? await resolveWorkItemAutomationKey(tx, params.automationWorkItemId)
      : null;
    const automationKey =
      workItemAutomationKey ?? params.backgroundAutomationKey;

    if (!automationKey) {
      return;
    }

    await upsertBackgroundAutomationSlackThread(tx, {
      surface: 'slack',
      automationKey,
      slackChannelId: params.channelId,
      threadTs: params.threadTs,
      summaryText: params.summaryText,
      postedAt: new Date(),
      metadata: {
        sourceTaskId: params.taskId,
      },
    });
  });
}

export async function postLateBoundWorkItemFailureMessage(params: {
  slack: SlackNotifier;
  channelId: string;
  threadTs?: string | null;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
  const text = [
    `**${buildSuggestionBadgePrefix({
      category: params.workItem.category,
      priority: params.workItem.priority,
    })}${params.workItem.title}**`,
    params.workItem.brief,
    '',
    `An automation queued this work item, but the execution task failed to launch: ${params.reason}`,
  ].join('\n');

  await params.slack.postMessage({
    channel: params.channelId,
    // Resolve an existing investigation thread instead of opening a new
    // channel-level root when the launch came from an announced run.
    ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
    text,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'markdown',
        text,
      },
    ],
  });
}
