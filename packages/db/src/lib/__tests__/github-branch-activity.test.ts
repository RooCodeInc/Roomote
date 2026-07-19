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
  findReusableGitHubIssueTaskOwner,
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
  host,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
  prSha?: string;
  sourceControlProvider?: SourceControlProvider;
  host?: string | null;
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
    host: host ?? null,
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
  host,
}: {
  repoFullName: string;
  prNumber: number;
  userId: string;
  payloadKind: TaskPayloadKind;
  status?: RunStatus;
  taskPhase?: string;
  prSha?: string;
  sourceControlProvider?: SourceControlProvider;
  host?: string | null;
}) {
  const taskId = await createPrLinkedTask({
    repoFullName,
    prNumber,
    userId,
    prSha,
    sourceControlProvider,
    host,
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

  it('does not let a GitHub branch run suppress lookups for another provider', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-cross-provider';
    const prNumber = 352;
    const branchName = 'feature/cross-provider';

    // Legacy GitHub payload: no sourceControlProvider field, which defaults
    // to 'github' at runtime.
    const githubRun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'GitHub work on the branch',
      },
    });

    // A GitLab scan for the same repository fullName + branch must not match
    // the GitHub run.
    const gitlabResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(gitlabResult).toBeNull();

    // The default (GitHub) lookup still matches the legacy payload.
    const githubResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(githubResult).toMatchObject({
      runId: githubRun.id,
      match: 'branch',
    });
  });

  it('matches provider-tagged branch runs only for the same provider', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-gitlab-branch';
    const prNumber = 353;
    const branchName = 'feature/gitlab-branch';

    const gitlabRun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        description: 'GitLab work on the branch',
      },
    });

    const gitlabResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(gitlabResult).toMatchObject({
      runId: gitlabRun.id,
      match: 'branch',
    });

    // The GitLab-tagged run must not suppress GitHub or ADO lookups.
    const githubResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(githubResult).toBeNull();

    const adoResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'ado',
    });

    expect(adoResult).toBeNull();
  });

  it('host-scopes PR association matches, tolerating legacy null-host rows', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-scope-pr';
    const prNumber = 362;
    const branchName = 'feature/host-scope-pr';

    const hostARun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-a.example',
    });

    // A same-name PR on another self-managed instance is a different PR:
    // the host-A association must not suppress a host-B lookup.
    const otherHostResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-b.example',
    });

    expect(otherHostResult).toBeNull();

    // The same-host lookup still matches.
    const sameHostResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-a.example',
    });

    expect(sameHostResult).toMatchObject({
      runId: hostARun.id,
      match: 'task_pull_request',
    });

    // A host-less lookup (legacy caller) is unchanged and still matches.
    const hostlessResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(hostlessResult).toMatchObject({
      runId: hostARun.id,
      match: 'task_pull_request',
    });
  });

  it('lets a legacy null-host PR association still suppress a host-scoped lookup', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-scope-null-pr';
    const prNumber = 363;

    const legacyRun = await createPrLinkedTaskRun({
      repoFullName,
      prNumber,
      userId: user.id,
      payloadKind: TaskPayloadKind.GithubPrReview,
      status: RunStatus.Running,
      taskPhase: 'running',
      sourceControlProvider: 'gitlab',
    });

    // A pre-backfill association row has no recorded host; it may be the
    // same PR, so a host-scoped lookup still treats it as active work.
    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName: 'feature/host-scope-null-pr',
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-a.example',
    });

    expect(result).toMatchObject({
      runId: legacyRun.id,
      match: 'task_pull_request',
    });
  });

  it('host-scopes branch payload matches by sourceControlHost', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-scope-branch';
    const prNumber = 364;
    const branchName = 'feature/host-scope-branch';

    const hostARun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        sourceControlHost: 'gitlab.host-a.example',
        description: 'GitLab work on the branch',
      },
    });

    // A payload stamped for host A must not match a host-B lookup.
    const otherHostResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-b.example',
    });

    expect(otherHostResult).toBeNull();

    const sameHostResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-a.example',
    });

    expect(sameHostResult).toMatchObject({
      runId: hostARun.id,
      match: 'branch',
    });

    // A host-less lookup (legacy caller) is unchanged and still matches.
    const hostlessResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(hostlessResult).toMatchObject({
      runId: hostARun.id,
      match: 'branch',
    });
  });

  it('lets an unstamped branch payload still suppress a host-scoped lookup', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-scope-unstamped';
    const prNumber = 365;
    const branchName = 'feature/host-scope-unstamped';

    const unstampedRun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        description: 'GitLab work on the branch',
      },
    });

    // A payload written before host stamping carries no sourceControlHost;
    // with no linkage row recording a conflicting host, it may be the same
    // branch, so the host-scoped lookup still matches.
    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'gitlab.host-a.example',
    });

    expect(result).toMatchObject({
      runId: unstampedRun.id,
      match: 'branch',
    });
  });

  it('does not let an unstamped payload suppress another host when the task linkage records a conflicting host', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-conflicting-linkage';
    const prNumber = 366;
    const branchName = 'feature/host-conflicting-linkage';

    // The task is pinned to host A by its linkage row, but its payload
    // predates host stamping (no sourceControlHost).
    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber,
      userId: user.id,
      sourceControlProvider: 'gitlab',
      host: 'a.example.com',
    });

    const run = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        description: 'Unstamped payload pinned to host A by linkage',
      },
    });

    // A host-B lookup must not match on either tier: the linkage host
    // excludes tier 1, and the conflicting linkage host disables the
    // unstamped-payload tolerance on tier 2.
    const hostBResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'b.example.com',
    });

    expect(hostBResult).toBeNull();

    // The host-A lookup still matches (tier 1, via the linkage row).
    const hostAResult = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'a.example.com',
    });

    expect(hostAResult).toMatchObject({
      runId: run.id,
      match: 'task_pull_request',
    });
  });

  it('keeps the unstamped-payload tolerance when the task linkage has no recorded host', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-host-null-linkage-branch';
    const prNumber = 367;
    const branchName = 'feature/host-null-linkage-branch';

    // The linkage row references a different PR number so tier 1 cannot
    // match; only the tier-2 branch fallback can. Its host is NULL, so it
    // is not a conflicting pin.
    const taskId = await createPrLinkedTask({
      repoFullName,
      prNumber: prNumber + 1,
      userId: user.id,
      sourceControlProvider: 'gitlab',
    });

    const run = await runFactory.create({
      actingUserId: user.id,
      taskId,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        description: 'Unstamped payload with a null-host linkage',
      },
    });

    const result = await findActiveGitHubBranchWork({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
      host: 'a.example.com',
    });

    expect(result).toMatchObject({
      runId: run.id,
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

  it('does not let a GitHub branch owner claim follow-ups for another provider', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-owner-cross-provider';
    const prNumber = 552;
    const branchName = 'feature/owner-cross-provider';

    // Legacy GitHub payload: no sourceControlProvider field, which defaults
    // to 'github' at runtime.
    const githubRun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        description: 'GitHub work on the branch',
      },
    });

    // A GitLab follow-up for the same repository fullName + branch must not
    // attach to the GitHub run.
    const gitlabResult = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(gitlabResult).toBeNull();

    // The default (GitHub) lookup still matches the legacy payload.
    const githubResult = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(githubResult).toMatchObject({
      runId: githubRun.id,
      match: 'branch',
      delivery: 'attach',
    });
  });

  it('matches provider-tagged branch owners only for the same provider', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-owner-gitlab-branch';
    const prNumber = 553;
    const branchName = 'feature/owner-gitlab-branch';

    const gitlabRun = await runFactory.create({
      actingUserId: user.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: repoFullName,
        branch: branchName,
        sourceControlProvider: 'gitlab',
        description: 'GitLab work on the branch',
      },
    });

    const gitlabResult = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'gitlab',
    });

    expect(gitlabResult).toMatchObject({
      runId: gitlabRun.id,
      match: 'branch',
      delivery: 'attach',
    });

    // The GitLab-tagged run must not claim GitHub or ADO follow-ups.
    const githubResult = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName,
    });

    expect(githubResult).toBeNull();

    const adoResult = await findReusableGitHubPrFollowUpOwner({
      repoFullName,
      prNumber,
      branchName,
      sourceControlProvider: 'ado',
    });

    expect(adoResult).toBeNull();
  });
});

describe('findReusableGitHubIssueTaskOwner', () => {
  async function createIssueLinkedStandardTaskRun({
    repoFullName,
    issueNumber,
    userId,
    status = RunStatus.Pending,
    taskPhase = null,
  }: {
    repoFullName: string;
    issueNumber: number;
    userId: string;
    status?: RunStatus;
    taskPhase?: string | null;
  }) {
    const task = await taskFactory.create({
      initiatorUserId: userId,
    });

    return runFactory.create({
      actingUserId: userId,
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status,
      taskPhase,
      payload: {
        repo: repoFullName,
        description: `work on #${issueNumber}`,
        linkedWorkItems: [
          {
            provider: 'github',
            identifier: String(issueNumber),
            repository: repoFullName,
            url: `https://github.com/${repoFullName}/issues/${issueNumber}`,
            title: `Issue #${issueNumber}`,
          },
        ],
      },
    });
  }

  it('returns null when no issue-linked tasks exist', async () => {
    const result = await findReusableGitHubIssueTaskOwner({
      repoFullName: 'owner/repo-issue-no-match',
      issueNumber: 991,
    });

    expect(result).toBeNull();
  });

  it('reuses a standard task linked to the same GitHub issue', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-issue-reuse';
    const issueNumber = 88;

    const run = await createIssueLinkedStandardTaskRun({
      repoFullName,
      issueNumber,
      userId: user.id,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    // Different issue should not match.
    await createIssueLinkedStandardTaskRun({
      repoFullName,
      issueNumber: issueNumber + 1,
      userId: user.id,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    const result = await findReusableGitHubIssueTaskOwner({
      repoFullName,
      issueNumber,
    });

    expect(result).toEqual({
      runId: run.id,
      taskId: run.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Running,
      taskPhase: 'running',
      delivery: 'attach',
    });
  });

  it('does not match a linked issue on a different repository', async () => {
    const { user } = await createActor();
    const issueNumber = 89;

    await createIssueLinkedStandardTaskRun({
      repoFullName: 'owner/other-repo',
      issueNumber,
      userId: user.id,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    const result = await findReusableGitHubIssueTaskOwner({
      repoFullName: 'owner/target-repo',
      issueNumber,
    });

    expect(result).toBeNull();
  });

  it('reuses a completed issue task with a snapshot via resume delivery', async () => {
    const { user } = await createActor();
    const repoFullName = 'owner/repo-issue-resume';
    const issueNumber = 90;

    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });
    const completed = await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
      taskPhase: null,
      snapshotId: 'snap-issue-1',
      payload: {
        repo: repoFullName,
        description: `done #${issueNumber}`,
        linkedWorkItems: [
          {
            provider: 'github',
            identifier: String(issueNumber),
            repository: repoFullName,
          },
        ],
      },
    });

    const result = await findReusableGitHubIssueTaskOwner({
      repoFullName,
      issueNumber,
    });

    expect(result).toEqual({
      runId: completed.id,
      taskId: completed.taskId,
      type: TaskPayloadKind.StandardTask,
      status: RunStatus.Completed,
      taskPhase: null,
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
