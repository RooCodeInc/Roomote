import { getInstallationOctokit } from '@roomote/github';

export async function getCurrentGitHubPrHeadSha({
  installationId,
  repository,
  prNumber,
}: {
  installationId: number;
  repository: string;
  prNumber: number;
}): Promise<string | null> {
  const [owner, repo] = repository.split('/');

  if (!owner || !repo) {
    return null;
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const pullRequest = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return pullRequest.data.head.sha || null;
  } catch (error) {
    console.warn(
      `[getCurrentGitHubPrHeadSha] failed for ${repository}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
