import { SlackNotifier } from '@roomote/slack';
import {
  and,
  asc,
  automationWorkItems,
  cloudJobs,
  db,
  eq,
  getBackgroundAgentSettingsForDeployment,
  isNull,
  resolveManagerSlackChannelId,
  slackInstallationChannels,
  slackInstallations,
  sql,
  updateBackgroundAutomationRunArtifactsByTaskId,
  upsertBackgroundAutomationSlackThread,
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

  const settings = await getBackgroundAgentSettingsForDeployment();
  const configuredChannelId = resolveManagerSlackChannelId(
    settings,
    params.slackConfig.managerChannelKind,
  );

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
    const boundJobs = await tx
      .update(cloudJobs)
      .set({
        slackThreadTs: params.threadTs,
        payload: sql`coalesce(${cloudJobs.payload}, '{}'::jsonb) || ${slackThreadPayloadPatch}::jsonb`,
      })
      .where(
        and(
          eq(cloudJobs.taskId, params.taskId),
          isNull(cloudJobs.slackThreadTs),
        ),
      )
      .returning({ id: cloudJobs.id });

    // Another reply already bound a thread for this task; keep its metadata.
    if (boundJobs.length === 0) {
      return;
    }

    if (!params.automationWorkItemId) {
      return;
    }

    const [automationWorkItem] = await tx
      .select({
        automationKey: automationWorkItems.automationKey,
        sourceTaskId: automationWorkItems.sourceTaskId,
      })
      .from(automationWorkItems)
      .where(and(eq(automationWorkItems.id, params.automationWorkItemId)))
      .limit(1);

    if (!automationWorkItem?.sourceTaskId) {
      return;
    }

    await updateBackgroundAutomationRunArtifactsByTaskId(tx, {
      taskId: automationWorkItem.sourceTaskId,
      slackChannelId: params.channelId,
      threadTs: params.threadTs,
    });

    await upsertBackgroundAutomationSlackThread(tx, {
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
