import {
  and,
  claimWorkItem,
  db,
  eq,
  sql,
  trackedMessages,
} from '@roomote/db/server';

export type ClaimedCurrentThreadSuggestion = {
  id: string;
  title: string;
  brief: string | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId?: string | null;
  launchClaimedAt: Date;
};

type CurrentThreadSuggestionReactionClaim =
  | { outcome: 'no_card' }
  | { outcome: 'already_started' }
  | { outcome: 'claimed'; suggestion: ClaimedCurrentThreadSuggestion };

type CurrentThreadSuggestionMessage = {
  surface: 'discord' | 'telegram' | 'teams';
  channelId: string;
  messageId: string;
};

async function findCurrentThreadSuggestionCardByMessage(
  input: CurrentThreadSuggestionMessage,
): Promise<{
  workItemId: string | null;
  metadata: Record<string, unknown> | null;
} | null> {
  const channelCondition =
    input.surface === 'teams'
      ? sql`split_part(${trackedMessages.channelId}, ';messageid=', 1) = split_part(${input.channelId}, ';messageid=', 1)`
      : eq(trackedMessages.channelId, input.channelId);
  const trackedCard = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.surface, input.surface),
      eq(trackedMessages.kind, 'suggestion_card'),
      channelCondition,
      eq(trackedMessages.messageTs, input.messageId),
    ),
    columns: { workItemId: true, metadata: true },
  });

  return trackedCard ?? null;
}

export async function findCurrentThreadSuggestionIdByMessage(
  input: CurrentThreadSuggestionMessage,
): Promise<string | null> {
  const trackedCard = await findCurrentThreadSuggestionCardByMessage(input);
  return trackedCard?.workItemId ?? null;
}

export async function claimCurrentThreadSuggestionByMessage(
  input: CurrentThreadSuggestionMessage,
): Promise<CurrentThreadSuggestionReactionClaim> {
  const trackedCard = await findCurrentThreadSuggestionCardByMessage(input);
  const workItemId = trackedCard?.workItemId;

  if (!workItemId) {
    return { outcome: 'no_card' };
  }

  const claimed = await claimWorkItem(db, { id: workItemId });
  if (!claimed) {
    return { outcome: 'already_started' };
  }

  // Cards marked launchRouting: 'router' are presentation-only chat-reply
  // suggestions; drop their pinned launch metadata so the task router selects
  // the workspace. Unmarked cards (scan and setup) keep their verified
  // targets.
  const routed = trackedCard.metadata?.launchRouting === 'router';

  return {
    outcome: 'claimed',
    suggestion: {
      id: claimed.id,
      title: claimed.title,
      brief: claimed.brief,
      investigationContext: routed ? null : claimed.investigationContext,
      targetRepositoryFullName: routed
        ? null
        : claimed.targetRepositoryFullName,
      targetEnvironmentId: routed ? null : claimed.targetEnvironmentId,
      launchClaimedAt: claimed.launchClaimedAt,
    },
  };
}
