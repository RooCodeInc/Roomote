import { syncGitHubPullRequestFactsForAllOrgs } from '@roomote/sdk/server';

const LOG_PREFIX = '[pullRequestAnalyticsSync]';

export async function pullRequestAnalyticsSyncJob(
  opts: { manualTrigger?: boolean } = {},
) {
  console.log(
    `${LOG_PREFIX} Starting sync${opts.manualTrigger ? ' (manual)' : ''}`,
  );

  const results = await syncGitHubPullRequestFactsForAllOrgs();
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
}
