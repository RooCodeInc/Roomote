import type { SourceControlProvider } from '@roomote/types';

import { getSourceControlPullRequestDetailsForRepository } from '../pull-requests/source-control-pull-request-reads';
import { resolveRepositoryRow } from '../pull-requests/source-control-pull-request-shared';

export type LivePullRequestState = 'open' | 'closed' | 'merged';

/**
 * The pull request's state as the provider reports it right now.
 *
 * The persisted `task_pull_requests.status` is maintained by webhooks and
 * can lag or miss a merge entirely; a delivery that has waited long enough
 * for that to matter must not auto-dispatch work against a pull request
 * that is already merged or closed. Any failure to read the live state
 * returns null so the caller falls back to the persisted status rather
 * than blocking on the provider.
 */
export async function readLivePullRequestStateForNotification(input: {
  provider: SourceControlProvider;
  host?: string | null;
  repository: string;
  prNumber: number;
}): Promise<LivePullRequestState | null> {
  try {
    const repository = await resolveRepositoryRow({
      provider: input.provider,
      repositoryFullName: input.repository,
      ...(input.host ? { host: input.host } : {}),
    });
    const details = await getSourceControlPullRequestDetailsForRepository({
      repository,
      provider: input.provider,
      prNumber: input.prNumber,
    });
    return details.state;
  } catch (error) {
    console.warn(
      `[PrReviewNotification] Could not read the live state of ${input.repository}#${input.prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
