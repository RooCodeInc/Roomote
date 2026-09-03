import {
  and,
  asc,
  claimWorkItem,
  db,
  eq,
  inArray,
  isNotNull,
  sql,
  trackedMessages,
  workItems,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
} from '@roomote/types';

import { apiLogger } from '../../logging.js';
import type { FastAgentStartResult } from '../fast-agent-entry.js';
import { launchClaimedSuggestedTask } from '../tasks/suggestion-launch.js';
import {
  resolveSuggestedTaskLaunchTarget,
  type SuggestedTaskLaunchTarget,
} from '../tasks/suggestion-launch-target.js';
import { claimCurrentThreadSuggestionByMessage } from '../tasks/current-thread-suggestion-reaction.js';
import { stripTeamsMessageIdSuffix } from './find-active-teams-run.js';

/**
 * Structured "start idea N" hook for the Teams suggestion lists.
 *
 * Teams posts its setup-onboarding and scheduled-automation suggestions as one
 * numbered markdown message ("Message me the one you want, for example 'start
 * idea 2'"). Unlike Slack (reaction) and Telegram (inline button) there is no
 * structured callback, so before this hook the typed reply flowed through the
 * generic task-entry path: no work-item claim (a suggestion could be started
 * twice), no `launched_task_id` link, no fenced finalize.
 *
 * This module conservatively parses a whole-message "start idea N" / "idea N"
 * reply, resolves N against the most recently posted suggestion card group in
 * the conversation, and drives the launch through the shared work_items claim
 * state machine exactly like the other surfaces: claim CAS -> launch ->
 * finalize with the claim's `launchClaimedAt` fencing token (release with the
 * token on every no-launch/failure path). Anything that does not parse, or a
 * conversation with no tracked suggestion cards, falls through to normal task
 * entry unchanged. No fuzzy matching by design.
 */

/**
 * Whole-message match only: "start idea 2", "idea 2", "Idea #2", optional
 * trailing "." or "!". Anything else (extra words, ranges, spelled-out
 * numbers) is NOT a suggestion start and falls through to normal task entry.
 */
const TEAMS_SUGGESTION_START_PATTERN =
  /^(?:start\s+)?idea\s+#?(\d{1,2})\s*[.!]?$/i;

export function parseTeamsSuggestionStartText(text: string): number | null {
  const match = TEAMS_SUGGESTION_START_PATTERN.exec(text.trim());

  if (!match) {
    return null;
  }

  const ideaNumber = Number(match[1]);

  return Number.isInteger(ideaNumber) && ideaNumber >= 1 ? ideaNumber : null;
}

/**
 * The claimed suggestion with its fencing token (`launchClaimedAt`), mirroring
 * the Telegram claim shape.
 */
export type ClaimedTeamsSuggestion = {
  id: string;
  title: string;
  brief: string | null;
  investigationContext: string | null;
  targetRepositoryFullName: string | null;
  targetEnvironmentId?: string | null;
  usesRouterLaunch?: boolean;
  launchTarget?: string;
  launchClaimedAt: Date;
};

type TeamsSuggestionStartResolution =
  /** No tracked suggestion cards in this conversation — fall through. */
  | { outcome: 'no_cards' }
  /** Cards exist but N is outside the latest posted list. */
  | { outcome: 'not_found'; ideaCount: number }
  /** The claim CAS lost: already launched/launching/terminal. */
  | { outcome: 'already_started'; title: string }
  | { outcome: 'claimed'; suggestion: ClaimedTeamsSuggestion };

/**
 * Resolve "idea N" against the newest suggestion card group posted in this
 * Teams conversation and claim the backing work item.
 *
 * Tracked rows for a single Teams suggestion post share one intro message:
 * `message_ts = '<introMessageId>:<workItemId>'` (the suffix keeps
 * `(kind, dedupe_key)` unique). The newest group (by `created_at`) is the list
 * the user is looking at; within it, the posted numbering is the work items'
 * `sort_order` (the post renders the suggestions in persisted order).
 *
 * Conversation ids are compared in bare form (thread replies arrive with a
 * `;messageid=<root>` suffix while the cards store the base conversation id).
 *
 * The claim runs through the shared `claimWorkItem` CAS; the returned
 * `launchClaimedAt` is the caller's fencing token.
 */
export async function resolveAndClaimTeamsSuggestionStart(input: {
  conversationId: string;
  threadId?: string;
  ideaNumber: number;
}): Promise<TeamsSuggestionStartResolution> {
  const conversationBase = stripTeamsMessageIdSuffix(input.conversationId);

  const cards = await db
    .select({
      workItemId: trackedMessages.workItemId,
      messageTs: trackedMessages.messageTs,
      threadTs: trackedMessages.threadTs,
      createdAt: trackedMessages.createdAt,
    })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, 'teams'),
        eq(trackedMessages.kind, 'suggestion_card'),
        sql`split_part(${trackedMessages.channelId}, ';messageid=', 1) = ${conversationBase}`,
        sql`${trackedMessages.metadata} ->> 'suggestionGroupKey' IS NULL`,
        isNotNull(trackedMessages.workItemId),
      ),
    );

  const inputThreadId =
    input.threadId ?? input.conversationId.split(';messageid=')[1] ?? null;
  const matchingThreadCards = inputThreadId
    ? cards.filter((card) => card.threadTs === inputThreadId)
    : [];
  const scopedCards = inputThreadId ? matchingThreadCards : cards;

  if (scopedCards.length === 0) {
    return { outcome: 'no_cards' };
  }

  // Group cards by their intro message and keep the newest group: the list the
  // user is replying to. message_ts is '<introMessageId>:<workItemId>'; strip
  // the known workItemId suffix (intro ids may themselves contain ':').
  const groups = new Map<string, { createdAt: Date; workItemIds: string[] }>();

  for (const card of scopedCards) {
    if (!card.workItemId || !card.messageTs) {
      continue;
    }

    const suffix = `:${card.workItemId}`;
    const groupKey = card.messageTs.endsWith(suffix)
      ? card.messageTs.slice(0, -suffix.length)
      : card.messageTs;
    const group = groups.get(groupKey);

    if (group) {
      group.workItemIds.push(card.workItemId);

      if (card.createdAt > group.createdAt) {
        group.createdAt = card.createdAt;
      }
    } else {
      groups.set(groupKey, {
        createdAt: card.createdAt,
        workItemIds: [card.workItemId],
      });
    }
  }

  const latestGroup = [...groups.values()].reduce((latest, group) =>
    group.createdAt > latest.createdAt ? group : latest,
  );

  // Posted numbering = persisted sort order (the post renders suggestions in
  // the order they were persisted).
  const items = await db
    .select({ id: workItems.id, title: workItems.title })
    .from(workItems)
    .where(inArray(workItems.id, latestGroup.workItemIds))
    .orderBy(asc(workItems.sortOrder), asc(workItems.createdAt));

  const target = items[input.ideaNumber - 1];

  if (!target) {
    return { outcome: 'not_found', ideaCount: items.length };
  }

  const claimed = await claimWorkItem(db, { id: target.id });

  if (!claimed) {
    return { outcome: 'already_started', title: target.title };
  }

  return {
    outcome: 'claimed',
    suggestion: {
      id: claimed.id,
      title: claimed.title,
      brief: claimed.brief,
      investigationContext: claimed.investigationContext,
      targetRepositoryFullName: claimed.targetRepositoryFullName,
      targetEnvironmentId: claimed.targetEnvironmentId,
      launchClaimedAt: claimed.launchClaimedAt,
    },
  };
}

export async function resolveAndClaimTeamsSuggestionReaction(input: {
  conversationId: string;
  messageId: string;
}): Promise<TeamsSuggestionStartResolution> {
  const claim = await claimCurrentThreadSuggestionByMessage({
    surface: 'teams',
    channelId: input.conversationId,
    messageId: input.messageId,
  });

  if (claim.outcome === 'no_card') {
    return { outcome: 'no_cards' };
  }
  if (claim.outcome === 'already_started') {
    return { outcome: 'already_started', title: 'That idea' };
  }
  return { outcome: 'claimed', suggestion: claim.suggestion };
}

/** Mirrors the Telegram suggestion-button prompt shape. */
function buildTeamsSuggestionTaskPromptText(
  suggestion: ClaimedTeamsSuggestion,
): string {
  return [
    suggestion.title,
    '',
    suggestion.brief ?? '',
    ...(suggestion.targetRepositoryFullName &&
    suggestion.targetRepositoryFullName !== ALL_REPOSITORIES &&
    suggestion.targetRepositoryFullName !== FAST_EXECUTION
      ? ['', `Target repository: ${suggestion.targetRepositoryFullName}`]
      : []),
    ...(suggestion.targetEnvironmentId
      ? ['', `Target environment: ${suggestion.targetEnvironmentId}`]
      : []),
    ...(suggestion.investigationContext
      ? ['', `Context: ${suggestion.investigationContext}`]
      : []),
  ].join('\n');
}

/** Minimal structural view of a pinned suggestion launch outcome. */
type TeamsSuggestionLaunchOutcome = {
  status: 'started';
  launchResult: { id: number; taskId: string };
};

type LaunchClaimedTeamsSuggestionResult =
  | { result: 'started'; runId: number | null }
  | { result: 'replied_inline' }
  /** The launch was refused with a reason that was posted to the user. */
  | { result: 'rejected' }
  /**
   * The fenced finalize lost to a reclaim after the task was enqueued: the
   * orphaned run was best-effort canceled and the user got a corrective
   * reply. Matches the claim-CAS-lose outcome — never reported as started.
   */
  | { result: 'already_started' }
  | { result: 'launch_failed' };

/**
 * Launch a claimed Teams suggestion and close the work-item state machine.
 *
 * The claim's `launchClaimedAt` is this launcher's fencing token; it is
 * threaded through `finalizeWorkItemLaunched` on success and
 * `releaseWorkItemClaim` on every no-launch/failure path, so a slow launcher
 * whose stale claim was reclaimed cannot stomp the new claimant's state and a
 * failed launch is retryable immediately instead of dead for the 10-minute
 * stale window.
 */
export async function launchClaimedTeamsSuggestion(params: {
  suggestion: ClaimedTeamsSuggestion;
  /** Launches the task from the suggestion prompt inside the owning Session. */
  launchTask: (
    promptText: string,
    target: SuggestedTaskLaunchTarget,
  ) => Promise<TeamsSuggestionLaunchOutcome>;
  /**
   * Starts a Fast turn from the suggestion prompt. Must resolve on admission
   * (not turn completion) so the claim is finalized promptly, and return an
   * abort handle so a lost finalize can cancel the orphaned turn.
   */
  launchFast?: (promptText: string) => Promise<FastAgentStartResult>;
  /** Posts a best-effort visible reply into the conversation. */
  postMessage: (text: string) => Promise<void>;
}): Promise<LaunchClaimedTeamsSuggestionResult> {
  const { suggestion } = params;
  const target = resolveSuggestedTaskLaunchTarget(suggestion);
  // Cards without a pinned workspace let Fast decide; pinned cards delegate
  // through the owning Session without a model turn.
  const usesFastTurn = target.kind === 'fast' || target.kind === 'router';
  const launchResult = await launchClaimedSuggestedTask({
    suggestion,
    policy: {
      fastEligible: usesFastTurn,
      userDefaultEnabled: usesFastTurn,
      fastAvailable: Boolean(params.launchFast),
      requiredMode: usesFastTurn ? ('fast' as const) : ('coding' as const),
    },
    launch: async (mode) => {
      const promptText = buildTeamsSuggestionTaskPromptText(suggestion);
      if (mode === 'fast') {
        const fastStart = (await params.launchFast?.(promptText)) ?? {
          accepted: false as const,
          reason: 'Fast mode is unavailable.',
        };
        return fastStart.accepted
          ? {
              accepted: true,
              runId: null,
              taskId: null,
              abort: fastStart.abort,
            }
          : fastStart;
      }
      const launch = await params.launchTask(promptText, target);
      return {
        accepted: true,
        runId: launch.launchResult.id,
        taskId: launch.launchResult.taskId,
      };
    },
  });

  if (launchResult.status === 'started') {
    return { result: 'started', runId: launchResult.runId };
  }
  if (launchResult.status === 'rejected') {
    // A reasoned rejection (a refused Fast turn) posted nothing itself;
    // reasonless rejections already replied inline from task routing.
    if (launchResult.reason) {
      await params.postMessage(
        `Could not start "${suggestion.title}" — ${launchResult.reason}`,
      );
      return { result: 'rejected' };
    }
    return { result: 'replied_inline' };
  }
  if (
    launchResult.status === 'finalize_lost' ||
    launchResult.status === 'finalize_failed'
  ) {
    apiLogger.warn(
      `[teams] failed to finalize work item ${suggestion.id}; task ${launchResult.taskId ?? 'null'} (run ${launchResult.runId ?? 'null'}) — ${launchResult.cancelNote}`,
    );
    await params.postMessage(
      `"${suggestion.title}" was already started elsewhere — this duplicate launch was canceled.`,
    );
    return { result: 'already_started' };
  }

  apiLogger.warn(
    `[teams] Failed to launch suggestion ${suggestion.id}: ${launchResult.error instanceof Error ? launchResult.error.message : String(launchResult.error)}`,
  );
  await params.postMessage(
    launchResult.readOnly
      ? MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE
      : `Could not start "${suggestion.title}" — try describing the task in a message instead.`,
  );
  return { result: 'launch_failed' };
}
