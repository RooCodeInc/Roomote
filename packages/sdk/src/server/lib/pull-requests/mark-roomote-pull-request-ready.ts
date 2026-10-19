import {
  and,
  db,
  eq,
  getDeploymentMarkRoomotePrReadyAfterCleanReview,
  getDeploymentPrAction,
  taskPullRequests,
} from '@roomote/db/server';
import {
  getSourceControlProviderLabel,
  supportsPullRequestDraftTransition,
  type SourceControlProvider,
} from '@roomote/types';
import {
  isDraftTitle,
  resolveRepositoryRow,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';
import {
  assertProviderDraftState,
  createProviderPullRequestUpdates,
  removeDraftTitlePrefix,
  type ProviderPullRequestState,
} from './provider-pull-request-updates';
import { updateTaskPrStatus } from './update-task-pr-status';
import {
  acquirePullRequestDraftTransitionLock,
  isPullRequestAutoReadyBlocked,
} from './pull-request-draft-intent';

type ReviewResult = {
  outcome: string | null;
  findingCount: number | null;
  headSha: string | null;
};

export type MarkRoomotePullRequestReadyResult =
  | 'marked_ready'
  | 'already_ready'
  | 'disabled'
  | 'unsupported'
  | 'not_roomote_created'
  | 'draft_requested'
  | 'review_not_clean'
  | 'pull_request_not_open'
  | 'head_changed';

/**
 * Promotes a Roomote-created draft after its persisted terminal review result
 * is clean. Every provider verifies the remote head before and after mutation;
 * unsupported capability or response shapes fail closed.
 */
export async function markRoomotePullRequestReadyAfterCleanReview(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  host?: string;
  prNumber: number;
  reviewHeadSha: string;
  reviewResult: ReviewResult;
  fetchImpl?: FetchImpl;
}): Promise<MarkRoomotePullRequestReadyResult> {
  const [enabled, prAction] = await Promise.all([
    getDeploymentMarkRoomotePrReadyAfterCleanReview(),
    getDeploymentPrAction(),
  ]);
  if (!enabled || prAction !== 'draft') return 'disabled';
  if (!supportsPullRequestDraftTransition(input.sourceControlProvider))
    return 'unsupported';
  if (
    input.reviewResult.outcome !== 'clean' ||
    (input.reviewResult.findingCount !== null &&
      input.reviewResult.findingCount !== 0) ||
    input.reviewResult.headSha !== input.reviewHeadSha
  )
    return 'review_not_clean';

  const repository = await resolveRepositoryRow({
    provider: input.sourceControlProvider,
    repositoryFullName: input.repository,
    host: input.host,
  });
  const association = await db.query.taskPullRequests.findFirst({
    where: and(
      eq(taskPullRequests.sourceControlProvider, input.sourceControlProvider),
      eq(taskPullRequests.repositoryId, repository.id),
      eq(taskPullRequests.prNumber, input.prNumber),
      eq(taskPullRequests.createdByRoomote, true),
    ),
    columns: { id: true },
  });
  if (!association) return 'not_roomote_created';

  const releaseLifecycleLock = await acquirePullRequestDraftTransitionLock(
    repository,
    input.prNumber,
  );
  try {
    releaseLifecycleLock.signal.throwIfAborted();
    if (await isPullRequestAutoReadyBlocked(repository, input.prNumber))
      return 'draft_requested';
    const result = await markProviderPullRequestReady(
      input.sourceControlProvider,
      {
        repository,
        prNumber: input.prNumber,
        reviewHeadSha: input.reviewHeadSha,
        fetchImpl: input.fetchImpl ?? fetch,
        signal: releaseLifecycleLock.signal,
      },
    );
    if (result === 'marked_ready' || result === 'already_ready') {
      await updateTaskPrStatus(
        input.sourceControlProvider,
        input.repository,
        input.prNumber,
        'open',
        {
          host: repository.host,
          repositoryId: repository.id,
        },
      );
    }
    return result;
  } finally {
    await releaseLifecycleLock();
  }
}

async function markProviderPullRequestReady(
  provider: SourceControlProvider,
  input: {
    repository: RepositoryRow;
    prNumber: number;
    reviewHeadSha: string;
    fetchImpl: FetchImpl;
    signal: AbortSignal;
  },
): Promise<MarkRoomotePullRequestReadyResult> {
  const updates = await createProviderPullRequestUpdates(
    provider,
    input.repository,
    input.prNumber,
    input.fetchImpl,
  );
  const current = await updates.read();
  if (!current.open) return 'pull_request_not_open';
  if (current.headSha !== input.reviewHeadSha) return 'head_changed';
  if (
    current.draft === undefined &&
    (provider === 'ado' || provider === 'bitbucket')
  )
    return 'unsupported';
  if (!current.draft) return 'already_ready';
  if (
    provider === 'gitlab' &&
    removeDraftTitlePrefix(current.title ?? '') === current.title
  )
    return 'unsupported';
  if (provider === 'gitea' && !isDraftTitle(current.title))
    return 'unsupported';

  // GitHub may report a failed mutation after another actor already marked
  // the same head ready. Only promotion accepts that confirmed concurrent result.
  input.signal.throwIfAborted();
  let updated: ProviderPullRequestState;
  try {
    updated = await updates.update(
      current,
      {
        draft: false,
        ...(provider === 'gitlab' || provider === 'gitea'
          ? { title: removeDraftTitlePrefix(current.title ?? '') }
          : {}),
      },
      input.signal,
    );
  } catch (error) {
    if (provider !== 'github') throw error;
    const latest = await updates.read();
    if (!latest.open || latest.draft || latest.headSha !== input.reviewHeadSha)
      throw error;
    return 'already_ready';
  }
  const confirmationError = `${provider === 'bitbucket' ? 'Bitbucket' : getSourceControlProviderLabel(provider)} did not confirm ready transition for ${input.repository.fullName}${provider === 'gitlab' ? '!' : '#'}${input.prNumber}`;
  // GitHub's mutation must confirm readiness before its head can be trusted.
  if (provider === 'github')
    assertProviderDraftState(updated, false, confirmationError);
  if (updated.headSha !== input.reviewHeadSha) {
    const restoreDraft =
      provider === 'gitea' ? !isDraftTitle(updated.title) : !updated.draft;
    if (restoreDraft) {
      // Compensation deliberately remains possible after lock ownership loss.
      // Title-based providers restore the exact original title.
      await updates.update(
        updated,
        provider === 'gitlab' || provider === 'gitea'
          ? { title: current.title }
          : { draft: true },
      );
    }
    return 'head_changed';
  }
  assertProviderDraftState(updated, false, confirmationError);
  return 'marked_ready';
}
