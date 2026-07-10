import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { resolveEnvironmentSourceControlProvider } from '@/lib/server/source-control-provider';
import {
  db,
  workItems,
  asc,
  eq,
  and,
  inArray,
  cancelTaskRunDirect,
  claimWorkItem,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { isSetupNewOnboardingSuccessStatus } from '@/lib/setup-new';
import {
  SETUP_BOOTSTRAP_USER_ID,
  assertSetupQualificationNotBlocked,
  getMatchingEnvironmentSummary,
  getOnboardingTaskState,
  getPersistedSetupNewState,
  resolveSelectedRepositories,
  type MutableQueuedSetupTask,
  type PersistedQueuedSetupTask,
  type SelectedRepositorySummary,
} from './shared';
import { assertAdmin } from '../setup/shared';

async function getPersistedTaskSuggestionRows(suggestionIds?: string[]) {
  if (suggestionIds && suggestionIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      sortOrder: workItems.sortOrder,
    })
    .from(workItems)
    .where(
      suggestionIds
        ? and(
            eq(workItems.kind, 'suggestion'),
            inArray(workItems.id, suggestionIds),
          )
        : eq(workItems.kind, 'suggestion'),
    )
    .orderBy(asc(workItems.sortOrder));
}

export async function getPersistedQueuedSetupTasks(
  setupOnboardingTaskId: string | null,
  executor: DatabaseOrTransaction = db,
): Promise<PersistedQueuedSetupTask[]> {
  if (!setupOnboardingTaskId) {
    return [];
  }

  return executor
    .select({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));
}

async function getMutableQueuedSetupTasks(
  setupOnboardingTaskId: string,
  executor: DatabaseOrTransaction = db,
): Promise<MutableQueuedSetupTask[]> {
  return executor
    .select({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
      launchClaimedAt: workItems.launchClaimedAt,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));
}

/**
 * Mirrors a launched onboarding copy back onto its source suggestion so the
 * suggestions UI shows the suggestion as launched once its queued onboarding
 * copy launches. This is a status *mirror*, not a launch of its own, so it must
 * never stomp a live claim held by another surface.
 *
 * It goes through the shared fenced CAS: `claimWorkItem` the suggestion, and
 * only `finalizeWorkItemLaunched` when the claim succeeded. When another surface
 * (e.g. web-implement) already holds a fresh claim, or the suggestion is already
 * `launched`, the claim returns null and the mirror is skipped — never
 * overwriting that surface's status/token.
 *
 * `dismissed` is opted into the claimable set (matching the web-implement
 * surface in task-suggestions/implement.ts) with `clearDismissedAt`, so a
 * suggestion that was dismissed after being queued still flips to `launched`
 * when its onboarding copy launches. That is the least-surprising state: the
 * work genuinely launched, so the suggestions UI should reflect it rather than
 * showing the row as merely dismissed.
 *
 * The claim and finalize run in one transaction so a finalize failure rolls the
 * claim back rather than stranding the suggestion in `launching` with a live
 * claim until the 10-minute stale-claim recovery.
 */
async function markSuggestionWorkItemLaunched(
  input: {
    suggestionId: string;
    launchedTaskId: string;
  },
  executor: DatabaseOrTransaction = db,
) {
  await executor.transaction(async (tx) => {
    const claimedSuggestion = await claimWorkItem(tx, {
      id: input.suggestionId,
      additionalClaimableStatuses: ['dismissed'],
      extraConditions: [eq(workItems.kind, 'suggestion')],
    });

    if (!claimedSuggestion) {
      // Another surface holds a fresh claim, the suggestion already launched, or
      // it is terminally failed. Skip the mirror rather than overwrite it.
      console.warn(
        `[setup-new] Skipped mirroring launched state onto suggestion ${input.suggestionId}: it is already launched or another surface holds a fresh claim.`,
      );
      return;
    }

    const finalized = await finalizeWorkItemLaunched(tx, {
      id: input.suggestionId,
      taskId: input.launchedTaskId,
      claimedAt: claimedSuggestion.launchClaimedAt,
      clearDismissedAt: true,
    });

    if (!finalized) {
      // Our claim token was superseded between claim and finalize; leave the new
      // claimant's state untouched.
      console.warn(
        `[setup-new] Suggestion ${input.suggestionId} mirror lost the fencing guard after claiming; another surface reclaimed it. Leaving its state untouched.`,
      );
    }
  });
}

function stripMutableQueuedSetupTask(
  queuedTask: MutableQueuedSetupTask,
): PersistedQueuedSetupTask {
  const { launchClaimedAt: _launchClaimedAt, ...persistedQueuedTask } =
    queuedTask;

  return persistedQueuedTask;
}

function buildCustomQueuedTaskTitle(prompt: string) {
  const firstMeaningfulLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstMeaningfulLine) {
    return 'Custom task';
  }

  // Persist a fuller title in storage; the pill strip truncates further for display.
  return firstMeaningfulLine.length <= 120
    ? firstMeaningfulLine
    : `${firstMeaningfulLine.slice(0, 117)}...`;
}

async function replaceQueuedSetupTasks({
  setupOnboardingTaskId,
  selectedByUserId,
  selectedSuggestionIds,
  customTaskPrompt,
}: {
  setupOnboardingTaskId: string;
  selectedByUserId: string;
  selectedSuggestionIds: string[];
  customTaskPrompt: string | null;
}): Promise<PersistedQueuedSetupTask[]> {
  const suggestionRows = await getPersistedTaskSuggestionRows(
    selectedSuggestionIds,
  );
  const suggestionIdsBySortOrder = new Set(suggestionRows.map(({ id }) => id));

  if (suggestionIdsBySortOrder.size !== selectedSuggestionIds.length) {
    throw new Error(
      'One or more selected suggestions are no longer available.',
    );
  }

  return db.transaction(async (tx) => {
    const existingRows = await getMutableQueuedSetupTasks(
      setupOnboardingTaskId,
      tx,
    );

    // Refuse to replace the queue while a launch is genuinely in flight or an
    // item already launched. A *stale* `launchClaimedAt` (older than the shared
    // stale-claim window) is left by a crash between claim and finalize; with
    // per-item stale-claim recovery now in place that row is recoverable, so it
    // must not block re-queuing forever. Only a launched row or a fresh claim
    // blocks replacement.
    const staleClaimThreshold = new Date(
      Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
    );

    if (
      existingRows.some(
        (queuedTask) =>
          queuedTask.launchedAt !== null ||
          (queuedTask.launchClaimedAt !== null &&
            queuedTask.launchClaimedAt > staleClaimThreshold),
      )
    ) {
      return existingRows.map(stripMutableQueuedSetupTask);
    }

    await tx
      .delete(workItems)
      .where(
        and(
          eq(workItems.sourceTaskId, setupOnboardingTaskId),
          eq(workItems.kind, 'onboarding'),
        ),
      );

    const nextRows: Array<{
      kind: 'onboarding';
      sourceTaskId: string;
      selectedByUserId: string;
      sourceWorkItemId: string | null;
      title: string;
      executionPrompt: string;
      sortOrder: number;
    }> = suggestionRows.map((suggestion, index) => ({
      kind: 'onboarding',
      sourceTaskId: setupOnboardingTaskId,
      selectedByUserId,
      sourceWorkItemId: suggestion.id,
      title: suggestion.title,
      executionPrompt: suggestion.brief ?? '',
      sortOrder: index,
    }));

    if (customTaskPrompt) {
      nextRows.push({
        kind: 'onboarding',
        sourceTaskId: setupOnboardingTaskId,
        selectedByUserId,
        sourceWorkItemId: null,
        title: buildCustomQueuedTaskTitle(customTaskPrompt),
        executionPrompt: customTaskPrompt,
        sortOrder: nextRows.length,
      });
    }

    if (nextRows.length === 0) {
      return [];
    }

    return tx.insert(workItems).values(nextRows).returning({
      id: workItems.id,
      suggestionId: workItems.sourceWorkItemId,
      title: workItems.title,
      prompt: workItems.executionPrompt,
      sortOrder: workItems.sortOrder,
      launchedTaskId: workItems.launchedTaskId,
      launchedAt: workItems.launchedAt,
      environmentId: workItems.targetEnvironmentId,
    });
  });
}

type ClaimedQueuedSetupTask = {
  id: string;
  suggestionId: string | null;
  selectedByUserId: string | null;
  prompt: string | null;
  /** The `launchClaimedAt` fencing token for this claim. */
  claimedAt: Date;
};

/**
 * Claims the queued onboarding items for a setup task through the shared fenced
 * CAS, preserving the previous batch semantics: fetch the candidate onboarding
 * rows for the setup task in queue order, attempt to claim each, and return
 * whichever claims succeeded (each carrying its own fencing token).
 *
 * Migrated off the single batch UPDATE gated on `launchedAt IS NULL AND
 * launchClaimedAt IS NULL`, which had no stale-claim recovery: a crash between
 * claim and finalize left an item `launching` forever. `claimWorkItem` instead
 * claims `open` OR a stale `launching` row (older than the shared stale-claim
 * window) and guards `launched_task_id IS NULL`, so a crashed launch recovers,
 * a fresh in-flight claim on one item is skipped (only that item), and an
 * already-launched item is never re-claimed. Onboarding rows are inserted with
 * the `work_items.status` default of `open`, so the claim predicate matches the
 * rows produced by `replaceQueuedSetupTasks`. Each claim is its own atomic CAS,
 * so no wrapping transaction is needed.
 */
async function claimQueuedSetupTasksForLaunch(
  setupOnboardingTaskId: string,
): Promise<ClaimedQueuedSetupTask[]> {
  const candidates = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.sourceTaskId, setupOnboardingTaskId),
        eq(workItems.kind, 'onboarding'),
      ),
    )
    .orderBy(asc(workItems.sortOrder));

  const claimedTasks: ClaimedQueuedSetupTask[] = [];

  for (const candidate of candidates) {
    const claimed = await claimWorkItem(db, {
      id: candidate.id,
      extraConditions: [eq(workItems.kind, 'onboarding')],
    });

    if (!claimed) {
      continue;
    }

    claimedTasks.push({
      id: claimed.id,
      suggestionId: claimed.sourceWorkItemId,
      selectedByUserId: claimed.selectedByUserId,
      prompt: claimed.executionPrompt,
      claimedAt: claimed.launchClaimedAt,
    });
  }

  return claimedTasks;
}

// Exported for the DB-backed launch-lifecycle tests, which exercise the fenced
// claim/finalize/release flow directly. Not part of the tRPC command surface.
export async function launchQueuedSetupTasksIfReady({
  setupOnboardingTaskId,
  matchingEnvironmentId,
  slackTeamId,
  slackChannel,
  slackThreadTs,
  chatHandoffProvider,
  chatHandoffChannelId,
  chatHandoffThreadId,
  chatHandoffServiceUrl,
}: {
  setupOnboardingTaskId: string | null;
  matchingEnvironmentId: string | null;
  slackTeamId?: string | null;
  slackChannel?: string | null;
  slackThreadTs?: string | null;
  chatHandoffProvider?: string | null;
  chatHandoffChannelId?: string | null;
  chatHandoffThreadId?: string | null;
  chatHandoffServiceUrl?: string | null;
}) {
  if (!setupOnboardingTaskId || !matchingEnvironmentId) {
    return;
  }

  const claimedTasks = await claimQueuedSetupTasksForLaunch(
    setupOnboardingTaskId,
  );

  if (claimedTasks.length === 0) {
    return;
  }

  // Non-Slack kickoffs (Telegram, Teams) carry provider-neutral
  // communication metadata so the launched starter tasks reply into the same
  // chat that hosted the setup kickoff.
  const nonSlackChatHandoffProvider =
    chatHandoffProvider === 'telegram' || chatHandoffProvider === 'teams'
      ? chatHandoffProvider
      : null;
  const communicationMetadata =
    nonSlackChatHandoffProvider && chatHandoffChannelId
      ? {
          communicationProvider: nonSlackChatHandoffProvider,
          communicationChannelId: chatHandoffChannelId,
          // Telegram treats communicationThreadId as a forum-topic
          // message_thread_id, which the private primary chat does not have,
          // so only Teams threads starter-task replies under the kickoff
          // message.
          ...(nonSlackChatHandoffProvider === 'teams' && chatHandoffThreadId
            ? { communicationThreadId: chatHandoffThreadId }
            : {}),
          ...(chatHandoffServiceUrl
            ? { communicationServiceUrl: chatHandoffServiceUrl }
            : {}),
        }
      : {};

  const queuedSourceControlProvider =
    await resolveEnvironmentSourceControlProvider(matchingEnvironmentId);

  await Promise.allSettled(
    claimedTasks.map(async (queuedTask) => {
      let launchResult: Awaited<ReturnType<typeof enqueueCloudTask>>;

      try {
        launchResult = await enqueueCloudTask({
          task: {
            type: TaskPayloadKind.StandardTask,
            payload: {
              repo: '',
              environmentId: matchingEnvironmentId,
              ...(queuedSourceControlProvider
                ? { sourceControlProvider: queuedSourceControlProvider }
                : {}),
              ...(slackTeamId ? { teamId: slackTeamId } : {}),
              ...(slackChannel ? { slackChannel } : {}),
              ...(slackThreadTs ? { slackThreadTs } : {}),
              ...communicationMetadata,
              description: queuedTask.prompt ?? '',
            },
          },
          initiator: {
            kind: 'user',
            userId: queuedTask.selectedByUserId ?? SETUP_BOOTSTRAP_USER_ID,
          },
          workflow: 'setup_onboarding',
          surface: 'web',
          trigger: 'manual',
          ...(slackChannel || slackThreadTs
            ? {
                channels: {
                  slackChannelId: slackChannel ?? null,
                  slackThreadTs: slackThreadTs ?? null,
                },
              }
            : {}),
        });
      } catch (error) {
        // The enqueue never succeeded, so no run exists: release our claim back
        // to `open` so a later trigger can retry promptly. The fenced release
        // never reverts a `launched` item and never reverts a claim already
        // reclaimed by another launcher. Only a pre-enqueue failure may release;
        // see the post-enqueue invariant below.
        await releaseWorkItemClaim(db, {
          id: queuedTask.id,
          claimedAt: queuedTask.claimedAt,
          extraConditions: [eq(workItems.kind, 'onboarding')],
        });

        console.warn(
          `[setup-new] enqueue failed for onboarding work item ${queuedTask.id}; released its claim back to open — ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        return;
      }

      // Fenced finalize: `launching` -> `launched` only when our claim token
      // still matches, stamping `targetEnvironmentId` in the same guarded write.
      // Runs directly against `db` (not a transaction): it is a single fenced
      // UPDATE, and the suggestion mirror below deliberately no longer shares
      // its atomicity so a mirror failure can never roll back a healthy launch.
      //
      // Invariant: once the task is enqueued, a failure of unknown cause must
      // never release the claim. Releasing would let the next readiness pass
      // re-claim and launch a duplicate immediately, while leaving the claim in
      // place lets stale-claim recovery retry safely only after the shared
      // window. So a throw here is treated exactly like a lost finalize
      // (`finalized = false`), which drives the orphan-cancel branch. In the
      // rare ambiguous case where the finalize committed but its ack was lost,
      // the cancel may kill a healthy linked run; that trade is intentional — a
      // visibly canceled task beats a silent duplicate.
      let finalized: boolean;

      try {
        finalized = await finalizeWorkItemLaunched(db, {
          id: queuedTask.id,
          taskId: launchResult.taskId,
          claimedAt: queuedTask.claimedAt,
          targetEnvironmentId: matchingEnvironmentId,
        });
      } catch (error) {
        console.warn(
          `[setup-new] finalize threw for onboarding work item ${queuedTask.id} after enqueuing task ${launchResult.taskId} (run ${launchResult.id}); treating as a lost finalize and leaving the claim for stale-claim recovery — ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        finalized = false;
      }

      if (!finalized) {
        // The task is already enqueued but the finalize did not commit (the
        // fencing guard rejected it, or it threw), so the run is orphaned from
        // this work item. Best-effort cancel it while it is still pre-sandbox,
        // and log loudly either way with the cancel outcome (matches the
        // implement.ts orphan handling). Return before the mirror: a lost or
        // failed finalize must never mirror a launch that did not link.
        let cancelNote = 'orphaned run left running';

        try {
          const canceled = await cancelTaskRunDirect({
            runId: launchResult.id,
            error:
              'Canceled: setup-new queued task launch finalize lost the claim fencing guard',
          });
          cancelNote = canceled
            ? 'orphaned run canceled'
            : 'orphaned run cancel did not apply (already started or terminal)';
        } catch (cancelError) {
          cancelNote = `orphaned run cancel failed: ${
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError)
          }`;
        }

        console.warn(
          `[setup-new] finalize lost the fencing guard for onboarding work item ${queuedTask.id}; orphaned task ${launchResult.taskId} (run ${launchResult.id}) runs unlinked — ${cancelNote}.`,
        );
        return;
      }

      // Mirror the launched state onto the source suggestion only after a
      // committed finalize, outside any transaction and best-effort: the launch
      // link is already finalized and must stay finalized, so a mirror throw is
      // logged and swallowed rather than allowed to undo the launch.
      if (queuedTask.suggestionId) {
        try {
          await markSuggestionWorkItemLaunched({
            suggestionId: queuedTask.suggestionId,
            launchedTaskId: launchResult.taskId,
          });
        } catch (error) {
          console.warn(
            `[setup-new] failed to mirror launched state onto suggestion ${queuedTask.suggestionId} for task ${launchResult.taskId}; the onboarding launch stays finalized — ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
    }),
  );
}

export async function saveSetupNewQueuedTasksCommand(
  auth: UserAuthSuccess,
  input: {
    selectedSuggestionIds: string[];
    customTaskPrompt?: string;
  },
) {
  assertAdmin(auth);
  await assertSetupQualificationNotBlocked(auth);

  const setupNewState = await getPersistedSetupNewState();

  if (!setupNewState.onboardingTaskId) {
    throw new Error('Start setup before queuing onboarding tasks.');
  }

  const customTaskPrompt = input.customTaskPrompt?.trim() || null;
  const selectedSuggestionIds = [...new Set(input.selectedSuggestionIds)];

  const { selectedRepositories } = await resolveSelectedRepositories(
    setupNewState.selectedRepositoryIds,
  ).catch(() => ({
    normalizedRepositoryIds: setupNewState.selectedRepositoryIds,
    selectedRepositories: [] as SelectedRepositorySummary[],
  }));

  const matchingEnvironment = await getMatchingEnvironmentSummary({
    selectedRepositoryFullNames: selectedRepositories.map(
      (repository) => repository.fullName,
    ),
    onboardingTaskStartedAt: setupNewState.onboardingTaskStartedAt,
  });
  const onboardingTask = await getOnboardingTaskState(
    setupNewState.onboardingTaskId,
  );
  const onboardingTaskStatus = onboardingTask.status;
  const onboardingTaskPhase = onboardingTask.taskPhase;
  const onboardingSucceeded =
    isSetupNewOnboardingSuccessStatus(
      onboardingTaskStatus,
      onboardingTaskPhase,
    ) && matchingEnvironment !== null;

  await replaceQueuedSetupTasks({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    selectedByUserId: auth.userId,
    selectedSuggestionIds,
    customTaskPrompt,
  });

  await launchQueuedSetupTasksIfReady({
    setupOnboardingTaskId: setupNewState.onboardingTaskId,
    matchingEnvironmentId: onboardingSucceeded ? matchingEnvironment.id : null,
    slackTeamId: setupNewState.slackTeamId,
    slackChannel: setupNewState.slackChannel,
    slackThreadTs: setupNewState.slackThreadTs,
    chatHandoffProvider: setupNewState.chatHandoffProvider,
    chatHandoffChannelId: setupNewState.chatHandoffChannelId,
    chatHandoffThreadId: setupNewState.chatHandoffThreadId,
    chatHandoffServiceUrl: setupNewState.chatHandoffServiceUrl,
  });

  return {
    queuedOnboardingTasks: await getPersistedQueuedSetupTasks(
      setupNewState.onboardingTaskId,
    ),
  };
}
