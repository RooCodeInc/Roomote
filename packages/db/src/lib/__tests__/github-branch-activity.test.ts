import {
  cloudJobFactory,
  db,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '../../server';
import { CloudTaskStatus, CloudTaskType } from '@roomote/types';

import {
  DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS,
  findActiveGitHubPrReviewTask,
  findActiveGitHubBranchWork,
  findReusableGitHubPrFollowUpOwner,
  hasRecentGitHubBranchCommit,
} from '../github-branch-activity';

async function createActor() {
  const user = await userFactory.create();

  return { user };
}

async function createPrLinkedTaskJob({
  repoFullName,
  prNumber,
  userId,
  type,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
  type: CloudTaskType;
}) {
  const taskId = await createPrLinkedTask({
    repoFullName,
    prNumber,
    userId,
  });

  return cloudJobFactory.create({
    userId,
    taskId,
    type,
    status: CloudTaskStatus.Pending,
    payload: {
      repo: repoFullName,
      description: 'Make changes on this PR branch',
    },
  });
}

async function createSlackPrLinkedTaskJob({
  repoFullName,
  prNumber,
  userId,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
}) {
  const taskId = await createPrLinkedTask({
    repoFullName,
    prNumber,
    userId,
  });

  return cloudJobFactory.create({
    userId,
    taskId,
    type: CloudTaskType.SlackAppMention,
    status: CloudTaskStatus.Pending,
    payload: {
      repo: repoFullName,
      channel: 'C123',
      user: 'U123',
      text: 'Please update this PR',
      ts: '1234567890.123456',
    },
  });
}

async function createLinearPrLinkedTaskJob({
  repoFullName,
  prNumber,
  userId,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
}) {
  const taskId = await createPrLinkedTask({
    repoFullName,
    prNumber,
    userId,
  });

  return cloudJobFactory.create({
    userId,
    taskId,
    type: CloudTaskType.LinearAgentSession,
    status: CloudTaskStatus.Pending,
    linearSessionId: 'linear-session-1',
    linearOrganizationId: 'linear-org-1',
    payload: {
      repo: repoFullName,
      sessionId: 'linear-session-1',
      organizationId: 'linear-org-1',
      action: 'created',
      issueId: 'issue-1',
      issueIdentifier: 'ROOM-1',
      issueTitle: 'Follow up on this PR',
      issueUrl: 'https://linear.app/roomote/issue/ROOM-1',
    },
  });
}

async function createPrLinkedTask({
  repoFullName,
  prNumber,
  userId,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
}) {
  const task = await taskFactory.create({
    userId,
  });

  await db.insert(taskPullRequests).values({
    taskId: task.id,
    prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
    prNumber,
    prTitle: 'Test PR',
    repository: repoFullName,
    status: 'open',
  });

  return task.id;
}

async function createSnapshotResumeJob({
  userId,
  taskId,
  repoFullName,
  sourceCloudJobId,
}: {
  userId: string;
  taskId: string;
  repoFullName: string;
  sourceCloudJobId: number;
}) {
  return cloudJobFactory.create({
    userId,
    taskId,
    type: CloudTaskType.SnapshotResume,
    status: CloudTaskStatus.Running,
    taskPhase: 'running',
    sourceCloudJobId,
    payload: {
      repo: repoFullName,
      sourceSnapshotId: `snapshot-${sourceCloudJobId}`,
      sourceCloudJobId,
    },
  });
}

describe('findActiveGitHubBranchWork', () => {
  it('returns null when no matching jobs exist', async () => {
    const repoFullName = 'owner/repo-no-match-unique';
    const prNumber = 9_999;
    const branchName = 'feature/no-match';

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(result).toBeNull();
  });

  it('matches an active job already tied to the same PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-github-pr';
    const prNumber = 142;

    const job = await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'abc1234',
      },
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: job.id,
      taskId: job.taskId,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });
  });

  it('matches an active task linked to the PR through taskPullRequests', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-task-link';
    const prNumber = 242;
    const job = await createPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
      type: CloudTaskType.StandardTask,
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: job.id,
      taskId: job.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
    });
  });

  it('still returns the newest active PR job even when an older reusable owner exists', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-active-any-work';
    const prNumber = 243;

    await createPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
      type: CloudTaskType.StandardTask,
    });

    const newestJob = await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'def5678',
      },
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: newestJob.id,
      taskId: newestJob.taskId,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });
  });

  it('matches an active job working on the same repo branch', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-branch';
    const prNumber = 342;
    const branchName = 'feature/work-branch';

    const job = await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'Continue working on the branch',
      },
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(result).toEqual({
      jobId: job.id,
      taskId: job.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'branch',
    });
  });

  it('ignores jobs that are not actively running anymore', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-inactive';
    const prNumber = 442;
    const branchName = 'feature/inactive';

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Running,
      taskPhase: 'waiting_for_prompt',
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'Waiting for follow-up',
      },
    });

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Completed,
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'Already finished',
      },
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(result).toBeNull();
  });
});

describe('findReusableGitHubPrFollowUpOwner', () => {
  it('returns an older reusable owner when a newer non-reusable PR job exists', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-reusable-owner';
    const prNumber = 542;

    const reusableJob = await createPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
      type: CloudTaskType.StandardTask,
    });

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'def5678',
      },
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: reusableJob.id,
      taskId: reusableJob.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses Slack app mention tasks linked to the PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-implementation-follow-up';
    const prNumber = 543;

    const slackJob = await createSlackPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: slackJob.id,
      taskId: slackJob.taskId,
      type: CloudTaskType.SlackAppMention,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses Linear agent session tasks linked to the PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-linear-follow-up';
    const prNumber = 544;

    const linearJob = await createLinearPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: linearJob.id,
      taskId: linearJob.taskId,
      type: CloudTaskType.LinearAgentSession,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('ignores PR review follow-up owners and keeps the reusable implementation task', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-pr-review-follow-up';
    const prNumber = 545;

    const reusableJob = await createPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
      type: CloudTaskType.StandardTask,
    });

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReviewFollowUp,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        commentBody: '@roomote explain why this happened',
      },
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: reusableJob.id,
      taskId: reusableJob.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses snapshot resumes when their source chain comes from Slack app mention work', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-resume-implement';
    const prNumber = 546;
    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const sourceJob = await cloudJobFactory.create({
      userId: user.id,
      taskId,
      type: CloudTaskType.SlackAppMention,
      status: CloudTaskStatus.Completed,
      payload: {
        repo: repoFullName,
        channel: 'C123',
        user: 'U123',
        text: 'Please update this PR',
        ts: '1234567890.123456',
      },
    });

    const firstResume = await createSnapshotResumeJob({
      userId: user.id,
      taskId,
      repoFullName,
      sourceCloudJobId: sourceJob.id,
    });

    const activeResume = await createSnapshotResumeJob({
      userId: user.id,
      taskId,
      repoFullName,
      sourceCloudJobId: firstResume.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: activeResume.id,
      taskId: activeResume.taskId,
      type: CloudTaskType.SnapshotResume,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses snapshot resumes when their source chain comes from Linear agent session work', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-resume-plan';
    const prNumber = 547;
    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const planningSourceJob = await cloudJobFactory.create({
      userId: user.id,
      taskId,
      type: CloudTaskType.LinearAgentSession,
      status: CloudTaskStatus.Completed,
      linearSessionId: 'linear-session-1',
      linearOrganizationId: 'linear-org-1',
      payload: {
        repo: repoFullName,
        sessionId: 'linear-session-1',
        organizationId: 'linear-org-1',
        action: 'created',
        issueId: 'issue-1',
        issueIdentifier: 'ROOM-1',
        issueTitle: 'Follow up on this PR',
        issueUrl: 'https://linear.app/roomote/issue/ROOM-1',
      },
    });

    const activeResume = await createSnapshotResumeJob({
      userId: user.id,
      taskId,
      repoFullName,
      sourceCloudJobId: planningSourceJob.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: activeResume.id,
      taskId: activeResume.taskId,
      type: CloudTaskType.SnapshotResume,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('does not reuse snapshot resumes when their source chain comes from PR review follow-up work', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-resume-review-follow-up';
    const prNumber = 548;
    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const sourceJob = await cloudJobFactory.create({
      userId: user.id,
      taskId,
      type: CloudTaskType.GithubPrReviewFollowUp,
      status: CloudTaskStatus.Completed,
      prRepo: repoFullName,
      prNumber: prNumber,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        commentBody: '@roomote please fix this',
      },
    });

    await createSnapshotResumeJob({
      userId: user.id,
      taskId,
      repoFullName,
      sourceCloudJobId: sourceJob.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toBeNull();
  });

  it('finds an older reusable owner even when 10 newer non-reusable snapshot resumes exist', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-resume-mask';
    const prNumber = 546;

    const reusableJob = await createPrLinkedTaskJob({
      repoFullName,
      prNumber,
      userId: user.id,
      type: CloudTaskType.StandardTask,
    });

    for (let index = 0; index < 10; index += 1) {
      const taskId = await createPrLinkedTask({
        repoFullName,
        prNumber,
        userId: user.id,
      });

      const nonReusableSourceJob = await cloudJobFactory.create({
        userId: user.id,
        taskId,
        type: CloudTaskType.GithubPrReviewSync,
        status: CloudTaskStatus.Completed,
        prRepo: repoFullName,
        prNumber: prNumber,
        payload: {
          repo: repoFullName,
          prNumber,
          prTitle: `Review Sync PR ${index}`,
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          headSha: `deadbeef${index}`,
        },
      });

      await createSnapshotResumeJob({
        userId: user.id,
        taskId,
        repoFullName,
        sourceCloudJobId: nonReusableSourceJob.id,
      });
    }

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: reusableJob.id,
      taskId: reusableJob.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('returns a resumable owner when the latest reusable PR task is completed with a snapshot', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-resume-existing-owner';
    const prNumber = 547;

    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    const completedJob = await cloudJobFactory.create({
      userId: user.id,
      taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Completed,
      snapshotId: 'snapshot-547',
      payload: {
        repo: repoFullName,
        description: 'Continue this PR task from snapshot',
      },
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      jobId: completedJob.id,
      taskId: completedJob.taskId,
      type: CloudTaskType.StandardTask,
      status: CloudTaskStatus.Completed,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'resume',
    });
  });
});

describe('findActiveGitHubPrReviewTask', () => {
  it('returns the newest active review task for the same PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-review-active';
    const prNumber = 642;

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      prSha: 'def5678',
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Older review run',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'abc1234',
      },
    });

    const newestReview = await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      prSha: 'def5678',
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Newest review run',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'def5678',
      },
    });

    const result = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'def5678',
    });

    expect(result).toEqual({
      jobId: newestReview.id,
      taskId: newestReview.taskId,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });
  });

  it('ignores review jobs that are only waiting for prompt', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-review-warm';
    const prNumber = 643;

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'waiting_for_prompt',
      prRepo: repoFullName,
      prNumber: prNumber,
      prSha: 'abc1234',
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Warm review run',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'abc1234',
      },
    });

    const result = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'abc1234',
    });

    expect(result).toBeNull();
  });

  it('ignores active review jobs for an older PR head SHA', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-review-stale-sha';
    const prNumber = 644;

    await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReview,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      prSha: 'old-head-sha',
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Older review run',
        prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
        headSha: 'old-head-sha',
      },
    });

    const result = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'new-head-sha',
    });

    expect(result).toBeNull();
  });

  it('scopes by sourceControlProvider when provided', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-provider-scope';
    const prNumber = 645;

    const gitlabReview = await cloudJobFactory.create({
      userId: user.id,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      prRepo: repoFullName,
      prNumber: prNumber,
      prSha: 'shared-head-sha',
      prSourceControlProvider: 'gitlab',
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'GitLab sync review',
        prUrl: `https://gitlab.com/${repoFullName}/-/merge_requests/${prNumber}`,
        headSha: 'shared-head-sha',
      },
    });

    const matched = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'shared-head-sha',
      sourceControlProvider: 'gitlab',
    });

    expect(matched).toEqual({
      jobId: gitlabReview.id,
      taskId: gitlabReview.taskId,
      type: CloudTaskType.GithubPrReviewSync,
      status: CloudTaskStatus.Running,
      taskPhase: 'running',
      match: 'github_pr',
    });

    const unmatched = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'shared-head-sha',
      sourceControlProvider: 'gitea',
    });

    expect(unmatched).toBeNull();
  });
});

describe('hasRecentGitHubBranchCommit', () => {
  const now = new Date('2026-03-17T22:00:00.000Z');

  it('returns true for commits inside the idle window', () => {
    const latestCommitAt = new Date(
      now.getTime() - DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS + 1_000,
    );

    expect(
      hasRecentGitHubBranchCommit({
        latestCommitAt,
        now,
      }),
    ).toBe(true);
  });

  it('returns false for older commits or missing timestamps', () => {
    const latestCommitAt = new Date(
      now.getTime() - DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS - 1_000,
    );

    expect(
      hasRecentGitHubBranchCommit({
        latestCommitAt,
        now,
      }),
    ).toBe(false);
    expect(
      hasRecentGitHubBranchCommit({
        latestCommitAt: null,
        now,
      }),
    ).toBe(false);
  });
});
