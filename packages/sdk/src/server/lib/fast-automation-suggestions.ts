import { createHash } from 'node:crypto';

import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import {
  and,
  asc,
  db,
  eq,
  inArray,
  sql,
  trackedMessages,
  workItems,
} from '@roomote/db/server';
import type { SlackNotifier } from '@roomote/slack';

const SUGGESTION_METADATA_EVENT_TYPE = 'roomote.setup_onboarding_suggestion';

export type FastAutomationSuggestion = {
  title: string;
  brief: string;
};

type PersistedFastAutomationSuggestion = FastAutomationSuggestion & {
  id: string;
};

export function appendFastAutomationSuggestionInstruction(
  message: string,
  surface: 'slack' | 'discord',
  hasSuggestions: boolean,
): string {
  if (!hasSuggestions) return message;

  const instruction =
    surface === 'slack'
      ? "Want me to take one of these on? React with a :thumbsup: on a suggested task below and I'll start it."
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

async function hasTrackedSuggestion(
  surface: 'slack' | 'discord',
  workItemId: string,
): Promise<boolean> {
  return Boolean(
    await db.query.trackedMessages.findFirst({
      where: and(
        eq(trackedMessages.surface, surface),
        eq(trackedMessages.kind, 'suggestion_card'),
        eq(trackedMessages.workItemId, workItemId),
      ),
      columns: { id: true },
    }),
  );
}

async function trackSuggestion(params: {
  surface: 'slack' | 'discord';
  channelId: string;
  messageId: string;
  threadId?: string;
  workItemId: string;
  createdByUserId: string;
  eventId: string;
}): Promise<void> {
  await db
    .insert(trackedMessages)
    .values({
      surface: params.surface,
      kind: 'suggestion_card',
      dedupeKey: `${params.channelId}:${params.messageId}`,
      channelId: params.channelId,
      messageTs: params.messageId,
      ...(params.threadId ? { threadTs: params.threadId } : {}),
      workItemId: params.workItemId,
      createdByUserId: params.createdByUserId,
      metadata: {
        suggestionType: 'suggested_tasks',
        suggestionKey: `${params.eventId}:${params.workItemId}`,
        suggestionGroupKey: params.eventId,
        launchRouting: 'router',
      },
    })
    .onConflictDoNothing({
      target: [trackedMessages.kind, trackedMessages.dedupeKey],
    });
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
  for (const suggestion of suggestions) {
    if (await hasTrackedSuggestion('slack', suggestion.id)) continue;

    const text = formatSuggestion(suggestion);
    const messageId = await params.slack.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      client_msg_id: buildSlackSuggestionClientMessageId(
        `${params.eventId}:${suggestion.id}`,
      ),
      text,
      blocks: [{ type: 'markdown', text }],
      metadata: {
        event_type: SUGGESTION_METADATA_EVENT_TYPE,
        event_payload: {
          sourceTaskId: params.eventId,
          suggestionId: suggestion.id,
          schemaVersion: 1,
        },
      },
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
  for (const suggestion of suggestions) {
    if (await hasTrackedSuggestion('discord', suggestion.id)) continue;

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
    });
  }
}
