import { getInstallationOctokit } from './api';

type OctokitClient = Awaited<ReturnType<typeof getInstallationOctokit>>;

export async function getCommitCommittedAt({
  octokit,
  owner,
  repo,
  ref,
}: {
  octokit: OctokitClient;
  owner: string;
  repo: string;
  ref: string;
}): Promise<Date | null> {
  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref,
    });

    const committedAt =
      data.commit.committer?.date ?? data.commit.author?.date ?? null;

    return committedAt ? new Date(committedAt) : null;
  } catch (error) {
    console.warn(
      `[getCommitCommittedAt] Failed to fetch commit timestamp for ${owner}/${repo}@${ref}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}
