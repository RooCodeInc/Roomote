import { createHash } from 'node:crypto';

import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type { TeamsCommunicationProvider } from '@roomote/communication/teams-provider';
import type { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import {
  and,
  asc,
  db,
  eq,
  environments,
  findTrackedSuggestionWorkItemIds,
  inArray,
  isNull,
  registerTrackedSuggestionCards,
  sql,
  trackedMessages,
  workItems,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';
import {
  buildTaskSuggestionMessageMetadata,
  type SlackNotifier,
} from '@roomote/slack';

type FastAutomationSuggestion = {
  title: string;
  brief: string;
  environmentId?: string;
};

type PersistedFastAutomationSuggestion = FastAutomationSuggestion & {
  id: string;
};

export function appendFastAutomationSuggestionInstruction(
  message: string,
  surface: 'slack' | 'discord' | 'teams' | 'telegram',
  hasSuggestions: boolean,
): string {
  if (!hasSuggestions) return message;

  const instruction =
    surface === 'slack'
      ? "Want me to take one of these on? React with a :thumbsup: on a suggested task below and I'll start it."
      : surface === 'telegram'
        ? "Want me to take one of these on? Tap Start on a suggested task below and I'll launch it."
        : "Want me to take one of these on? React with a 👍 on a suggested task below and I'll start it.";
  return message.includes(instruction)
    ? message
    : `${message}\n\n${instruction}`;
}

function buildSuggestionFingerprint(
  eventId: string,
  suggestion: FastAutomationSuggestion,
  index: number,
): string {
  const contentHash = createHash('sha256')
    .update(JSON.stringify(suggestion))
    .digest('hex');
  return `fast-automation:${eventId}:${index}:${contentHash}`;
}

function buildSlackSuggestionClientMessageId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function persistFastAutomationSuggestions(params: {
  eventId: string;
  suggestions: FastAutomationSuggestion[];
}): Promise<PersistedFastAutomationSuggestion[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`fast-automation-suggestions:${params.eventId}`}))`,
    );
    const targetEnvironmentIds = [
      ...new Set(
        params.suggestions
          .map((suggestion) => suggestion.environmentId)
          .filter(
            (environmentId): environmentId is string =>
              Boolean(environmentId) &&
              environmentId !== ALL_REPOSITORIES &&
              environmentId !== FAST_EXECUTION,
          ),
      ),
    ];
    const hasInvalidTargetFormat = targetEnvironmentIds.some(
      (environmentId) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          environmentId,
        ),
    );
    if (hasInvalidTargetFormat) {
      throw new Error('A suggested task target environment is unavailable.');
    }
    const validTargetEnvironmentIds = new Set(
      targetEnvironmentIds.length === 0
        ? []
        : (
            await tx
              .select({ id: environments.id })
              .from(environments)
              .where(
                and(
                  inArray(environments.id, targetEnvironmentIds),
                  eq(environments.isEval, false),
                  isNull(environments.userId),
                ),
              )
          ).map((environment) => environment.id),
    );
    const invalidTarget = targetEnvironmentIds.find(
      (environmentId) => !validTargetEnvironmentIds.has(environmentId),
    );
    if (invalidTarget) {
      throw new Error('A suggested task target environment is unavailable.');
    }
    const inputs = params.suggestions.map((suggestion, index) => ({
      suggestion,
      index,
      fingerprint: buildSuggestionFingerprint(
        params.eventId,
        suggestion,
        index,
      ),
    }));
    const existing = await tx
      .select({
        id: workItems.id,
        title: workItems.title,
        brief: workItems.brief,
        fingerprint: workItems.fingerprint,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, 'suggestion'),
          inArray(
            workItems.fingerprint,
            inputs.map((input) => input.fingerprint),
          ),
        ),
      )
      .orderBy(asc(workItems.sortOrder));
    const byFingerprint = new Map(
      existing.map((suggestion) => [suggestion.fingerprint, suggestion]),
    );
    const missing = inputs.filter(
      (input) => !byFingerprint.has(input.fingerprint),
    );

    if (missing.length > 0) {
      const inserted = await tx
        .insert(workItems)
        .values(
          missing.map(({ suggestion, index, fingerprint }) => ({
            kind: 'suggestion' as const,
            title: suggestion.title,
            brief: suggestion.brief,
            ...(suggestion.environmentId === ALL_REPOSITORIES ||
            suggestion.environmentId === FAST_EXECUTION
              ? { targetRepositoryFullName: suggestion.environmentId }
              : suggestion.environmentId
                ? { targetEnvironmentId: suggestion.environmentId }
                : {}),
            fingerprint,
            status: 'open' as const,
            sortOrder: index,
          })),
        )
        .returning({
          id: workItems.id,
          title: workItems.title,
          brief: workItems.brief,
          fingerprint: workItems.fingerprint,
        });
      for (const suggestion of inserted) {
        byFingerprint.set(suggestion.fingerprint, suggestion);
      }
    }

    return inputs.map(({ suggestion, fingerprint }) => {
      const persisted = byFingerprint.get(fingerprint);
      if (!persisted) {
        throw new Error('Fast automation suggestion was not persisted.');
      }
      return {
        id: persisted.id,
        title: persisted.title,
        brief: persisted.brief ?? suggestion.brief,
        ...(suggestion.environmentId
          ? { environmentId: suggestion.environmentId }
          : {}),
      };
    });
  });
}

function formatSuggestion(
  suggestion: PersistedFastAutomationSuggestion,
): string {
  return `> **${suggestion.title}**\n${suggestion.brief
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`;
}

async function trackSuggestion(params: {
  surface: 'slack' | 'discord' | 'teams' | 'telegram';
  channelId: string;
  messageId: string;
  threadId?: string;
  workItemId: string;
  createdByUserId: string;
  eventId: string;
  launchTarget?: string;
}): Promise<void> {
  await registerTrackedSuggestionCards([
    {
      surface: params.surface,
      channelId: params.channelId,
      messageTs: params.messageId,
      threadTs: params.threadId,
      workItemId: params.workItemId,
      createdByUserId: params.createdByUserId,
      suggestionType: 'suggested_tasks',
      suggestionKey: `${params.eventId}:${params.workItemId}`,
      suggestionGroupKey: params.eventId,
      ...(params.launchTarget
        ? { launchTarget: params.launchTarget }
        : { launchRouting: 'router' as const }),
    },
  ]);
}

async function claimSuggestionSend(params: {
  surface: 'teams' | 'telegram';
  channelId: string;
  threadId?: string;
  workItemId: string;
  createdByUserId: string;
  eventId: string;
  launchTarget?: string;
}): Promise<string | null> {
  const [claim] = await db
    .insert(trackedMessages)
    .values({
      surface: params.surface,
      kind: 'suggestion_card',
      dedupeKey: `${params.surface}:${params.channelId}:${params.eventId}:${params.workItemId}`,
      channelId: params.channelId,
      ...(params.threadId ? { threadTs: params.threadId } : {}),
      workItemId: params.workItemId,
      createdByUserId: params.createdByUserId,
      metadata: {
        suggestionType: 'suggested_tasks',
        suggestionKey: `${params.eventId}:${params.workItemId}`,
        suggestionGroupKey: params.eventId,
        ...(params.launchTarget
          ? { launchTarget: params.launchTarget }
          : { launchRouting: 'router' }),
      },
    })
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    })
    .returning({ id: trackedMessages.id });
  return claim?.id ?? null;
}

async function finalizeSuggestionSend(params: {
  claimId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
}): Promise<void> {
  await db
    .update(trackedMessages)
    .set({
      dedupeKey: `${params.channelId}:${params.messageId}`,
      channelId: params.channelId,
      messageTs: params.messageId,
      threadTs: params.threadId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(trackedMessages.id, params.claimId));
}

export async function postFastAutomationSuggestionsToSlack(params: {
  slack: Pick<SlackNotifier, 'postMessage'>;
  channelId: string;
  threadTs: string;
  eventId: string;
  createdByUserId: string;
  suggestions: FastAutomationSuggestion[];
}): Promise<void> {
  const suggestions = await persistFastAutomationSuggestions(params);
  const trackedWorkItemIds = await findTrackedSuggestionWorkItemIds({
    surface: 'slack',
    workItemIds: suggestions.map((suggestion) => suggestion.id),
  });
  for (const suggestion of suggestions) {
    if (trackedWorkItemIds.has(suggestion.id)) continue;

    const text = formatSuggestion(suggestion);
    const messageId = await params.slack.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      client_msg_id: buildSlackSuggestionClientMessageId(
        `${params.eventId}:${suggestion.id}`,
      ),
      text,
      blocks: [{ type: 'markdown', text }],
      metadata: buildTaskSuggestionMessageMetadata({
        sourceTaskId: params.eventId,
        suggestionId: suggestion.id,
      }),
    });
    if (!messageId) {
      throw new Error('Slack did not post a Fast automation suggestion.');
    }
    await trackSuggestion({
      surface: 'slack',
      channelId: params.channelId,
      messageId,
      threadId: params.threadTs,
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      eventId: params.eventId,
      ...(suggestion.environmentId
        ? { launchTarget: suggestion.environmentId }
        : {}),
    });
  }
}

export async function postFastAutomationSuggestionsToDiscord(params: {
  provider: Pick<DiscordCommunicationProvider, 'postMessage'>;
  channelId: string;
  threadId?: string;
  eventId: string;
  createdByUserId: string;
  suggestions: FastAutomationSuggestion[];
}): Promise<void> {
  const suggestions = await persistFastAutomationSuggestions(params);
  const trackedWorkItemIds = await findTrackedSuggestionWorkItemIds({
    surface: 'discord',
    workItemIds: suggestions.map((suggestion) => suggestion.id),
  });
  for (const suggestion of suggestions) {
    if (trackedWorkItemIds.has(suggestion.id)) continue;

    const posted = await params.provider.postMessage({
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      idempotencyKey: `fast-automation-suggestion:${params.eventId}:${suggestion.id}`,
      text: formatSuggestion(suggestion),
    });
    if (!posted.messageId) {
      throw new Error('Discord did not post a Fast automation suggestion.');
    }
    await trackSuggestion({
      surface: 'discord',
      channelId: posted.threadId ?? posted.channelId,
      messageId: posted.messageId,
      ...(posted.threadId ? { threadId: posted.threadId } : {}),
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      eventId: params.eventId,
      ...(suggestion.environmentId
        ? { launchTarget: suggestion.environmentId }
        : {}),
    });
  }
}

export async function postFastAutomationSuggestionsToTeams(params: {
  provider: Pick<TeamsCommunicationProvider, 'postMessage'>;
  channelId: string;
  serviceUrl: string;
  threadId?: string;
  eventId: string;
  createdByUserId: string;
  suggestions: FastAutomationSuggestion[];
}): Promise<void> {
  const suggestions = await persistFastAutomationSuggestions(params);
  const trackedWorkItemIds = await findTrackedSuggestionWorkItemIds({
    surface: 'teams',
    workItemIds: suggestions.map((suggestion) => suggestion.id),
  });
  for (const suggestion of suggestions) {
    if (trackedWorkItemIds.has(suggestion.id)) continue;

    const claimId = await claimSuggestionSend({
      surface: 'teams',
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      eventId: params.eventId,
      ...(suggestion.environmentId
        ? { launchTarget: suggestion.environmentId }
        : {}),
    });
    if (!claimId) continue;

    const posted = await params.provider.postMessage({
      channelId: params.channelId,
      serviceUrl: params.serviceUrl,
      ...(params.threadId
        ? { threadId: params.threadId, replyToMessageId: params.threadId }
        : {}),
      text: formatSuggestion(suggestion),
      textFormat: 'markdown',
    });
    await finalizeSuggestionSend({
      claimId,
      channelId: posted.channelId,
      messageId: posted.messageId,
      ...(posted.threadId ? { threadId: posted.threadId } : {}),
    });
  }
}

export async function postFastAutomationSuggestionsToTelegram(params: {
  provider: Pick<TelegramCommunicationProvider, 'postMessage'>;
  channelId: string;
  threadId?: string;
  eventId: string;
  createdByUserId: string;
  suggestions: FastAutomationSuggestion[];
}): Promise<void> {
  const suggestions = await persistFastAutomationSuggestions(params);
  const trackedWorkItemIds = await findTrackedSuggestionWorkItemIds({
    surface: 'telegram',
    workItemIds: suggestions.map((suggestion) => suggestion.id),
  });
  for (const suggestion of suggestions) {
    if (trackedWorkItemIds.has(suggestion.id)) continue;

    const claimId = await claimSuggestionSend({
      surface: 'telegram',
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      workItemId: suggestion.id,
      createdByUserId: params.createdByUserId,
      eventId: params.eventId,
      ...(suggestion.environmentId
        ? { launchTarget: suggestion.environmentId }
        : {}),
    });
    if (!claimId) continue;

    const posted = await params.provider.postMessage({
      channelId: params.channelId,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      text: formatSuggestion(suggestion),
      textFormat: 'markdown',
      buttons: [[{ text: 'Start', callbackData: `idea:${suggestion.id}` }]],
    });
    await finalizeSuggestionSend({
      claimId,
      channelId: posted.channelId,
      messageId: posted.messageId,
      ...(posted.threadId ? { threadId: posted.threadId } : {}),
    });
  }
}
