import {
  enrichPullRequestFacts,
  syncGitHubPullRequestFactsForAllOrgs,
  syncSourceControlPullRequestFacts,
} from '@roomote/sdk/server';

const LOG_PREFIX = '[pullRequestAnalyticsSync]';

export async function pullRequestAnalyticsSyncJob(
  opts: { manualTrigger?: boolean } = {},
) {
  console.log(
    `${LOG_PREFIX} Starting sync${opts.manualTrigger ? ' (manual)' : ''}`,
  );

  // GitHub facts come from the analytics sync; the provider-neutral sync
  // covers merged PRs on GitLab/Gitea/Azure DevOps/Bitbucket repositories.
  const results = [
    ...(await syncGitHubPullRequestFactsForAllOrgs()),
    await syncSourceControlPullRequestFacts(),
  ];
  const totals = results.reduce(
    (acc, result) => ({
      eligibleRepositories:
        acc.eligibleRepositories + result.eligibleRepositories,
      processedRepositories:
        acc.processedRepositories + result.processedRepositories,
      failedRepositories: acc.failedRepositories + result.failedRepositories,
      cooledDownRepositories:
        acc.cooledDownRepositories + result.cooledDownRepositories,
    }),
    {
      eligibleRepositories: 0,
      processedRepositories: 0,
      failedRepositories: 0,
      cooledDownRepositories: 0,
    },
  );

  console.log(
    `${LOG_PREFIX} Completed: ${totals.processedRepositories}/${totals.eligibleRepositories} processed, ${totals.failedRepositories} failed, ${totals.cooledDownRepositories} cooled down`,
  );

  // Files touched and reviews need per-PR requests the list sync above
  // does not make; a bounded batch per pass keeps that traffic predictable.
  try {
    await enrichPullRequestFacts();
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} enrichment pass failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
