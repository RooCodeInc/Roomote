import {
  db,
  githubInstallations,
  repositories,
  taskPullRequests,
  taskRuns,
  tasks,
  DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS,
  DEFAULT_CONFLICT_RESOLVER_LABEL,
  findActiveGitHubBranchWork,
  getAutomationRuntime,
  hasRecentGitHubBranchCommit,
  isNull,
  eq,
  and,
  inArray,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import {
  getCommitCommittedAt,
  getInstallationOctokit,
  isRepoSkipped,
} from '@roomote/github';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  TaskPayloadKind,
  RunStatus,
  DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS,
  isConflictResolverMaxPrAgeDays,
} from '@roomote/types';
import { Env } from '@roomote/env';

import {
  CONFLICT_RESOLUTION_COMMENT_MARKER,
  DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
} from '@roomote/types';

import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[conflictScan]';

interface ActiveInstallation {
  installationId: number;
}

/**
 * Find active GitHub installations.
 */
async function findEligibleInstallations(): Promise<ActiveInstallation[]> {
  return db
    .select({
      installationId: githubInstallations.installationId,
    })
    .from(githubInstallations)
    .where(isNull(githubInstallations.suspendedAt));
}

/**
 * Get all active repositories for an installation.
 */
async function getActiveRepos(
  installationId: number,
): Promise<Array<{ fullName: string }>> {
  const installRow = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
  });

  if (!installRow) {
    return [];
  }

  const repos = await db
    .select({
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(eq(repositories.installationId, installRow.id));

  return repos;
}

/**
 * Check if there's already an active (pending/running) conflict resolution
 * run for the given PR.
 */
async function hasActiveResolutionRun(
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  const activeStatuses = [RunStatus.Pending, RunStatus.Running];

  const existing = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_conflict_resolve'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        inArray(taskRuns.status, activeStatuses),
      ),
    )
    .limit(1);

  return existing.length > 0;
}

/** Map conflict resolver frequency to minimum interval in milliseconds. */
const CONFLICT_RESOLVER_INTERVAL_MS: Record<string, number> = {
  every_hour: 60 * 60 * 1000,
  every_6_hours: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/**
 * Scan all eligible repos for PRs with merge conflicts.
 *
 * This serves as a backstop to the event-driven push handler, recovering
 * from missed webhooks or transient API failures.
 */
export async function conflictScanJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting scheduled conflict scan`);

  const result = emptyJobResult();
  const installations = await findEligibleInstallations();

  if (installations.length === 0) {
    result.skippedReason = 'No active GitHub installation.';
  }

  let totalCandidates = 0;
  let totalConflicting = 0;

  for (const { installationId } of installations) {
    const runtime = await getAutomationRuntime('conflict_resolver');
    const frequency = runtime.enabled ? runtime.scheduleMode : 'off';

    if (!frequency || frequency === 'off') {
      result.skippedReason = 'Automation is disabled.';
      continue;
    }

    // Frequency gating: skip if last run was too recent for the configured
    // frequency.
    const intervalMs = CONFLICT_RESOLVER_INTERVAL_MS[frequency];

    if (
      !opts.manualTrigger &&
      intervalMs &&
      runtime.lastRunAt &&
      Date.now() - runtime.lastRunAt.getTime() < intervalMs
    ) {
      console.log(
        `${LOG_PREFIX} Skipping deployment: last run ${Math.round((Date.now() - runtime.lastRunAt.getTime()) / 60_000)}m ago, interval ${Math.round(intervalMs / 60_000)}m`,
      );
      result.skippedReason = 'Not due yet.';
      continue;
    }

    const rawMaxPrAgeDays = runtime.settings.maxPrAgeDays;
    const conflictResolverMaxPrAgeDays =
      typeof rawMaxPrAgeDays === 'number' &&
      isConflictResolverMaxPrAgeDays(rawMaxPrAgeDays)
        ? rawMaxPrAgeDays
        : DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS;
    const conflictResolverLabel =
      typeof runtime.settings.label === 'string' &&
      runtime.settings.label.trim()
        ? runtime.settings.label
        : DEFAULT_CONFLICT_RESOLVER_LABEL;

    console.log(`${LOG_PREFIX} Scanning installation ${installationId}`);

    let candidateCount = 0;
    let conflictingCount = 0;
    let launchedTaskCount = 0;
    let notificationCount = 0;

    try {
      const octokit = await getInstallationOctokit({ installationId });
      const repos = await getActiveRepos(installationId);

      for (const repo of repos) {
        if (isRepoSkipped(repo.fullName)) {
          console.log(
            `${LOG_PREFIX} Skipping scheduled conflict scan for ${repo.fullName}`,
          );
          continue;
        }

        const [owner, repoName] = repo.fullName.split('/');

        if (!owner || !repoName) {
          continue;
        }

        const oldestAllowedUpdatedAt = new Date();
        oldestAllowedUpdatedAt.setDate(
          oldestAllowedUpdatedAt.getDate() -
            DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
        );
        const oldestAllowedCreatedAt = new Date();
        oldestAllowedCreatedAt.setDate(
          oldestAllowedCreatedAt.getDate() - conflictResolverMaxPrAgeDays,
        );

        const prs = await octokit.paginate(octokit.rest.pulls.list, {
          owner,
          repo: repoName,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        });

        for (const pr of prs) {
          // Must have the opt-in label
          const hasLabel = pr.labels.some(
            (l) => l.name === conflictResolverLabel,
          );

          if (!hasLabel) {
            continue;
          }

          // Must be within the lookback window
          const updatedAt = new Date(pr.updated_at);

          if (updatedAt < oldestAllowedUpdatedAt) {
            break;
          }

          const createdAt = new Date(pr.created_at);

          if (createdAt < oldestAllowedCreatedAt) {
            continue;
          }

          totalCandidates++;
          candidateCount++;

          // Check mergeability
          const { data: prDetail } = await octokit.rest.pulls.get({
            owner,
            repo: repoName,
            pull_number: pr.number,
          });

          if (prDetail.mergeable === false) {
            totalConflicting++;
            conflictingCount++;

            console.log(
              `${LOG_PREFIX} PR ${repo.fullName}#${pr.number} has conflicts`,
            );

            // Check for existing active resolution run (dedup guard)
            if (await hasActiveResolutionRun(repo.fullName, pr.number)) {
              console.log(
                `${LOG_PREFIX} Active resolution run exists for ${repo.fullName}#${pr.number} — skipping`,
              );
              continue;
            }

            const activeBranchWork = await findActiveGitHubBranchWork({
              repoFullName: repo.fullName,
              prNumber: pr.number,
              branchName: pr.head.ref,
            });

            if (activeBranchWork) {
              console.log(
                `${LOG_PREFIX} Skipping ${repo.fullName}#${pr.number} — active Roomote run ${activeBranchWork.runId} (${activeBranchWork.type}, match=${activeBranchWork.match}) is still working on the branch`,
              );
              continue;
            }

            const latestCommitAt = await getCommitCommittedAt({
              octokit,
              owner: pr.head.repo?.owner?.login ?? owner,
              repo: pr.head.repo?.name ?? repoName,
              ref: pr.head.sha,
            });

            if (!latestCommitAt) {
              console.warn(
                `${LOG_PREFIX} Skipping ${repo.fullName}#${pr.number} — could not determine head commit timestamp for ${pr.head.sha}`,
              );
              continue;
            }

            if (hasRecentGitHubBranchCommit({ latestCommitAt })) {
              console.log(
                `${LOG_PREFIX} Skipping ${repo.fullName}#${pr.number} — head branch had a recent commit at ${latestCommitAt.toISOString()} (idle window ${Math.round(DEFAULT_CONFLICT_RESOLUTION_IDLE_WINDOW_MS / 60_000)}m)`,
              );
              continue;
            }

            try {
              const prAuthorId = pr.user?.id;
              const prAuthorLogin = pr.user?.login;

              const launchResult = await enqueueTask({
                task: {
                  type: TaskPayloadKind.GithubPrConflictResolve,
                  payload: {
                    repo: repo.fullName,
                    prNumber: pr.number,
                    prTitle: pr.title,
                    prUrl: pr.html_url,
                    headRef: pr.head.ref,
                    baseRef: pr.base.ref,
                  },
                  githubLogin: prAuthorLogin,
                  githubUserId: prAuthorId,
                },
                initiator: {
                  kind: 'automation',
                  key: 'conflict_resolver',
                  ...(prAuthorId != null
                    ? {
                        actor: {
                          externalId: String(prAuthorId),
                          displayName: prAuthorLogin,
                        },
                      }
                    : {}),
                },
                workflow: 'pr_conflict_resolve',
                surface: 'github',
                trigger: opts.manualTrigger ? 'manual' : 'schedule',
                prLinkage: {
                  provider: 'github',
                  repository: repo.fullName,
                  prNumber: pr.number,
                  prUrl: pr.html_url,
                  prTitle: pr.title,
                  prSha: pr.head.sha,
                  prBaseRef: pr.base.ref,
                  prBaseSha: pr.base.sha,
                },
              });

              launchedTaskCount++;
              result.launchedTaskId ??= launchResult.taskId;
              console.log(
                `${LOG_PREFIX} Launched conflict resolution task run ${launchResult.id} for ${repo.fullName}#${pr.number}`,
              );

              try {
                const commentBody = `I see some merge conflicts here. [Working on them now...](${Env.R_APP_URL}/task/${launchResult.taskId})`;
                await octokit.rest.issues.createComment({
                  owner,
                  repo: repoName,
                  issue_number: pr.number,
                  body: [CONFLICT_RESOLUTION_COMMENT_MARKER, commentBody].join(
                    '\n',
                  ),
                });
              } catch (commentError) {
                console.error(
                  `${LOG_PREFIX} Failed to post "working on it" comment on ${repo.fullName}#${pr.number}:`,
                  commentError instanceof Error
                    ? commentError.message
                    : commentError,
                );
              }
            } catch (error) {
              console.error(
                `${LOG_PREFIX} Failed to enqueue resolution for ${repo.fullName}#${pr.number}:`,
                error instanceof Error ? error.message : error,
              );

              await postNotificationComment(
                octokit,
                owner,
                repoName,
                pr.number,
              );
              notificationCount++;
            }
          }
        }
      }

      result.completed = true;

      if (candidateCount === 0) {
        result.skippedReason ??= 'No labeled conflict candidates found.';
      }

      await recordAutomationRunOutcome(db, {
        key: 'conflict_resolver',
        status: candidateCount > 0 ? 'succeeded' : 'skipped',
        at: new Date(),
      });

      console.log(
        `${LOG_PREFIX} Installation ${installationId}: ${candidateCount} candidates, ${conflictingCount} conflicting, ${launchedTaskCount} launched, ${notificationCount} notified`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);

      await recordAutomationRunOutcome(db, {
        key: 'conflict_resolver',
        status: 'failed',
        at: new Date(),
        error: message,
      });

      console.error(
        `${LOG_PREFIX} Error scanning installation ${installationId}:`,
        message,
      );
    }
  }

  console.log(
    `${LOG_PREFIX} Scan complete: ${totalCandidates} candidates, ${totalConflicting} conflicting`,
  );

  return result;
}

/**
 * Post a notification comment on a PR indicating merge conflicts were detected.
 * Used as a fallback when conflict-resolution work cannot be enqueued.
 */
async function postNotificationComment(
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: 'This PR has merge conflicts that need to be resolved.',
  });
}
