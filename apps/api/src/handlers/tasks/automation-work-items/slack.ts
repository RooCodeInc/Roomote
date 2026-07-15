import { SlackNotifier } from '@roomote/slack';
import {
  and,
  asc,
  db,
  eq,
  getAutomationRuntime,
  isNull,
  slackInstallationChannels,
  slackInstallations,
  sql,
  taskRuns,
  tasks,
  upsertBackgroundAutomationSlackThread,
  workItems,
} from '@roomote/db/server';

import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import type { ScheduledSuggestionSlackConfig } from '../background-automation-slack.js';
import type { PersistedAutomationWorkItem } from './types.js';

export async function resolveAutomationSlackTarget(params: {
  slackConfig: ScheduledSuggestionSlackConfig;
}): Promise<{
  slack: SlackNotifier;
  channelId: string;
} | null> {
  const [slackInstallation] = await db
    .select({
      id: slackInstallations.id,
      botAccessToken: slackInstallations.botAccessToken,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true))
    .limit(1);

  if (!slackInstallation) {
    return null;
  }

  // Two-level fallback: the automation's own slack_channel target, then the
  // shared manager channel (getAutomationRuntime resolves both levels).
  const runtime = await getAutomationRuntime(params.slackConfig.automationKey);
  const configuredChannelId = runtime.slackChannelId;

  const [channel] = configuredChannelId
    ? [{ channelId: configuredChannelId }]
    : await db
        .select({ channelId: slackInstallationChannels.channelId })
        .from(slackInstallationChannels)
        .where(
          eq(
            slackInstallationChannels.slackInstallationId,
            slackInstallation.id,
          ),
        )
        .orderBy(asc(slackInstallationChannels.createdAt))
        .limit(1);

  if (!channel) {
    return null;
  }

  return {
    slack: new SlackNotifier(slackInstallation.botAccessToken),
    channelId: channel.channelId,
  };
}

export async function bindLateSlackThreadToTask(params: {
  taskId: string;
  channelId: string;
  threadTs: string;
  summaryText: string;
  automationWorkItemId?: string | null;
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

    if (!params.automationWorkItemId) {
      return;
    }

    const [automationWorkItem] = await tx
      .select({
        automationKey: workItems.automationKey,
        sourceTaskId: workItems.sourceTaskId,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, 'auto_fix'),
          eq(workItems.id, params.automationWorkItemId),
        ),
      )
      .limit(1);

    if (
      !automationWorkItem?.sourceTaskId ||
      !automationWorkItem.automationKey
    ) {
      return;
    }

    await upsertBackgroundAutomationSlackThread(tx, {
      surface: 'slack',
      automationKey: automationWorkItem.automationKey,
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
