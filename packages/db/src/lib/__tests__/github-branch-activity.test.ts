import {
  runFactory,
  db,
  taskFactory,
  taskPullRequests,
  userFactory,
} from '../../server';
import {
  RunStatus,
  TaskPayloadKind,
  type SourceControlProvider,
} from '@roomote/types';

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

async function createPrLinkedTask({
  repoFullName,
  prNumber,
  userId,
  prSha,
  sourceControlProvider = 'github',
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
  prSha?: string;
  sourceControlProvider?: SourceControlProvider;
}) {
  const task = await taskFactory.create({
    initiatorUserId: userId,
  });

  await db.insert(taskPullRequests).values({
    taskId: task.id,
    prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
    prNumber,
    prTitle: 'Test PR',
    repository: repoFullName,
    prSha: prSha ?? null,
    sourceControlProvider,
    status: 'open',
  });

  return task.id;
}

async function createPrLinkedTaskRun({
  repoFullName,
  prNumber,
  userId,
  payloadKind,
  status = RunStatus.Pending,
  taskPhase,
  prSha,
  sourceControlProvider,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
  payloadKind: TaskPayloadKind;
  status?: RunStatus;
  taskPhase?: string;
  prSha?: string;
  sourceControlProvider?: SourceControlProvider;
}) {
  const taskId = await createPrLinkedTask({
    repoFullName,
    prNumber,
    userId,
    prSha,
    sourceControlProvider,
  });

  return runFactory.create({
    actingUserId: userId,
    taskId,
    payloadKind,
    status,
    taskPhase,
    payload: {
      repo: repoFullName,
      prNumber,
      prTitle: 'Test PR',
      prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
      headSha: prSha ?? 'abc1234',
    },
  });
}

async function createSlackPrLinkedTaskRun({
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

  return runFactory.create({
    actingUserId: userId,
    taskId,
    payloadKind: TaskPayloadKind.SlackAppMention,
    status: RunStatus.Pending,
    payload: {
      repo: repoFullName,
      channel: 'C123',
      user: 'U123',
      text: 'Please update this PR',
      ts: '1234567890.123456',
    },
  });
}

async function createLinearPrLinkedTaskRun({
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

  return runFactory.create({
    actingUserId: userId,
    taskId,
    payloadKind: TaskPayloadKind.LinearAgentSession,
    status: RunStatus.Pending,
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

async function createSnapshotResumeRun({
  userId,
  taskId,
  repoFullName,
  sourceRunId,
}: {
  userId: string;
  taskId: string;
  repoFullName: string;
  sourceRunId: number;
}) {
  return runFactory.create({
    actingUserId: userId,
    taskId,
    payloadKind: TaskPayloadKind.SnapshotResume,
    kind: 'resume',
    status: RunStatus.Running,
    taskPhase: 'running',
    sourceRunId,
    payload: {
      repo: repoFullName,
      sourceSnapshotId: `snapshot-${sourceRunId}`,
      sourceRunId: sourceRunId,
    },
  });
}

describe('findActiveGitHubBranchWork', () => {
  it('returns null when no matching runs exist', async () => {
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

  it('matches an active run linked to the same PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-github-pr';
    const prNumber = 142;

    const run = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: run.id,
      taskId: run.taskId,
      type: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
    });
  });

  it('still returns the newest active PR run even when an older reusable owner exists', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-active-any-work';
    const prNumber = 243;

    await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const newestRun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'def5678',
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: newestRun.id,
      taskId: newestRun.taskId,
      type: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
    });
  });

  it('matches an active run working on the same repo branch', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-branch';
    const prNumber = 342;
    const branchName = 'feature/work-branch';

    const run = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
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
      runId: run.id,
      taskId: run.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'branch',
    });
  });

  it('ignores runs that are not actively running anymore', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-inactive';
    const prNumber = 442;
    const branchName = 'feature/inactive';

    await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'Waiting for follow-up',
      },
    });

    await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
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
  it('returns an older reusable owner when a newer non-reusable PR run exists', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-reusable-owner';
    const prNumber = 542;

    const reusableRun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'def5678',
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: reusableRun.id,
      taskId: reusableRun.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses Slack app mention tasks linked to the PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-implementation-follow-up';
    const prNumber = 543;

    const slackTaskRun = await createSlackPrLinkedTaskRun({
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
      runId: slackTaskRun.id,
      taskId: slackTaskRun.taskId,
      type: TaskPayloadKind.SlackAppMention,
      status: RunStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('reuses Linear agent session tasks linked to the PR', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-linear-follow-up';
    const prNumber = 544;

    const linearRun = await createLinearPrLinkedTaskRun({
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
      runId: linearRun.id,
      taskId: linearRun.taskId,
      type: TaskPayloadKind.LinearAgentSession,
      status: RunStatus.Pending,
      taskPhase: null,
      match: 'task_pull_request',
      delivery: 'attach',
    });
  });

  it('ignores PR review follow-up owners and keeps the reusable implementation task', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-pr-review-follow-up';
    const prNumber = 545;

    const reusableRun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const followUpTaskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: followUpTaskId,
      payloadKind: TaskPayloadKind.GithubPrReviewFollowUp,
      status: RunStatus.Running,
      taskPhase: 'running',
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
      runId: reusableRun.id,
      taskId: reusableRun.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Pending,
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

    const sourceRun = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.SlackAppMention,
      status: RunStatus.Completed,
      payload: {
        repo: repoFullName,
        channel: 'C123',
        user: 'U123',
        text: 'Please update this PR',
        ts: '1234567890.123456',
      },
    });

    const firstResume = await createSnapshotResumeRun({
      userId: user.id,
      taskId,
      repoFullName,
      sourceRunId: sourceRun.id,
    });

    const activeResume = await createSnapshotResumeRun({
      userId: user.id,
      taskId,
      repoFullName,
      sourceRunId: firstResume.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: activeResume.id,
      taskId: activeResume.taskId,
      type: TaskPayloadKind.SnapshotResume,
      status: RunStatus.Running,
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

    const planningSourceRun = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.LinearAgentSession,
      status: RunStatus.Completed,
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

    const activeResume = await createSnapshotResumeRun({
      userId: user.id,
      taskId,
      repoFullName,
      sourceRunId: planningSourceRun.id,
    });

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: activeResume.id,
      taskId: activeResume.taskId,
      type: TaskPayloadKind.SnapshotResume,
      status: RunStatus.Running,
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

    const sourceRun = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.GithubPrReviewFollowUp,
      status: RunStatus.Completed,
      payload: {
        repo: repoFullName,
        prNumber,
        prTitle: 'Test PR',
        commentBody: '@roomote please fix this',
      },
    });

    await createSnapshotResumeRun({
      userId: user.id,
      taskId,
      repoFullName,
      sourceRunId: sourceRun.id,
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

    const reusableRun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    for (let index = 0; index < 10; index += 1) {
      const taskId = await createPrLinkedTask({
        repoFullName,
        prNumber,
        userId: user.id,
      });

      const nonReusableSourceRun = await runFactory.create({
        actingUserId: user.id,
        taskId,
        payloadKind: TaskPayloadKind.GithubPrReviewSync,
        status: RunStatus.Completed,
        payload: {
          repo: repoFullName,
          prNumber,
          prTitle: `Review Sync PR ${index}`,
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          headSha: `deadbeef${index}`,
        },
      });

      await createSnapshotResumeRun({
        userId: user.id,
        taskId,
        repoFullName,
        sourceRunId: nonReusableSourceRun.id,
      });
    }

    const result = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName: 'feature/work',
    });

    expect(result).toEqual({
      runId: reusableRun.id,
      taskId: reusableRun.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Pending,
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

    const completedRun = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
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
      runId: completedRun.id,
      taskId: completedRun.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
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

    await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'def5678',
    });

    const newestReview = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'def5678',
    });

    const result = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'def5678',
    });

    expect(result).toEqual({
      runId: newestReview.id,
      taskId: newestReview.taskId,
      type: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
    });
  });

  it('ignores review runs that are only waiting for prompt', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-review-warm';
    const prNumber = 643;

    await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'waiting_for_prompt',
      prSha: 'abc1234',
    });

    const result = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'abc1234',
    });

    expect(result).toBeNull();
  });

  it('ignores active review runs for an older PR head SHA', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-review-stale-sha';
    const prNumber = 644;

    await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'old-head-sha',
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

    const gitlabReview = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      prSha: 'shared-head-sha',
      sourceControlProvider: 'gitlab',
    });

    const matched = await findActiveGitHubPrReviewTask({
      repoFullName,
      prNumber,
      headSha: 'shared-head-sha',
      sourceControlProvider: 'gitlab',
    });

    expect(matched).toEqual({
      runId: gitlabReview.id,
      taskId: gitlabReview.taskId,
      type: TaskPayloadKind.GithubPrReviewSync,
      status: RunStatus.Running,
      taskPhase: 'running',
      match: 'task_pull_request',
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
