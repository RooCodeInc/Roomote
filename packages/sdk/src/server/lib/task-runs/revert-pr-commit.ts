import {
  DEFAULT_SOURCE_CONTROL_PROVIDER,
  type AuthTokenContext,
} from '@roomote/types';
import { db, repositories, eq, and } from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';

export const revertPrCommit = async (
  _auth: AuthTokenContext,
  {
    repo,
    prNumber,
    commitSha,
  }: {
    repo: string;
    prNumber: number;
    commitSha: string;
  },
) => {
  try {
    const repository = await db.query.repositories.findFirst({
      where: and(
        eq(repositories.sourceControlProvider, DEFAULT_SOURCE_CONTROL_PROVIDER),
        eq(repositories.fullName, repo),
        eq(repositories.isActive, true),
      ),
      with: { githubInstallation: true },
    });

    if (!repository?.githubInstallation) {
      throw new Error(`Repository ${repo} not found or not accessible`);
    }

    const octokit = await getInstallationOctokit(repository.githubInstallation);

    const [owner, repoName] = repo.split('/');

    const { data: pr } = await octokit.rest.pulls.get({
      owner: owner!,
      repo: repoName!,
      pull_number: prNumber,
    });

    if (pr.merged) {
      throw new Error('Cannot revert commits on merged pull requests');
    }

    if (pr.state === 'closed') {
      throw new Error('Cannot revert commits on closed pull requests');
    }

    const { data: refData } = await octokit.rest.git.getRef({
      owner: owner!,
      repo: repoName!,
      ref: `heads/${pr.head.ref}`,
    });

    const currentHeadSha = refData.object.sha;

    // Verify the commit to revert is the current HEAD.
    // This prevents accidentally discarding commits that came after the target commit.
    if (currentHeadSha !== commitSha) {
      throw new Error(
        'Can only revert the most recent commit on the branch. ' +
          `Current HEAD is ${currentHeadSha.substring(0, 7)}, ` +
          `but trying to revert ${commitSha.substring(0, 7)}. ` +
          'Please revert commits in reverse chronological order.',
      );
    }

    // Get the commit to revert (which we've verified is HEAD).
    const { data: commitToRevert } = await octokit.rest.git.getCommit({
      owner: owner!,
      repo: repoName!,
      commit_sha: commitSha,
    });

    // Get the parent commit (what we're reverting to).
    if (commitToRevert.parents.length === 0) {
      throw new Error('Cannot revert initial commit');
    }

    const parentSha = commitToRevert.parents[0]!.sha;

    // Get the tree of the parent commit (state before the commit we're reverting)
    const { data: parentCommit } = await octokit.rest.git.getCommit({
      owner: owner!,
      repo: repoName!,
      commit_sha: parentSha,
    });

    // Create a new commit with the parent's tree (this effectively reverts the changes).
    const { data: revertCommit } = await octokit.rest.git.createCommit({
      owner: owner!,
      repo: repoName!,
      message: `Revert "${commitToRevert.message.split('\n')[0]}"\n\nThis reverts commit ${commitSha}.`,
      tree: parentCommit.tree.sha,
      parents: [currentHeadSha],
    });

    // Update the branch to point to the new revert commit.
    await octokit.rest.git.updateRef({
      owner: owner!,
      repo: repoName!,
      ref: `heads/${pr.head.ref}`,
      sha: revertCommit.sha,
    });

    const revertSha = revertCommit.sha;

    return {
      success: true,
      revertSha,
      message: `Successfully reverted commit ${commitSha.substring(0, 7)}`,
    };
  } catch (error) {
    console.error(
      `[revertPrCommit] Failed to revert commit ${commitSha.substring(0, 7)}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while reverting the commit',
    };
  }
};
