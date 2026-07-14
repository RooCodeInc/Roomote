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
  type SourceControlProvider,
} from '@roomote/types';
import { Env } from '@roomote/env';

import {
  CONFLICT_RESOLUTION_COMMENT_MARKER,
  DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
} from '@roomote/types';

import {
  getSourceControlPullRequestDetailsForRepository,
  listOpenSourceControlPullRequestsForRepository,
} from '../lib/pull-requests/source-control-pull-request-reads';
import type { RepositoryRow } from '../lib/pull-requests/source-control-pull-request-shared';

import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[conflictScan]';

/**
 * Providers the scan covers through the provider-neutral list/read primitive.
 * Gitea and Bitbucket stay unsupported: Bitbucket exposes no mergeable
 * signal at all and Gitea computes mergeability asynchronously, so neither
 * yields a trustworthy conflict signal for an unattended automation.
 */
const PROVIDER_NEUTRAL_SCAN_PROVIDERS = [
  'gitlab',
  'ado',
] as const satisfies readonly SourceControlProvider[];

/** Cap on open PRs fetched per non-GitHub repository in one scan pass. */
const PROVIDER_NEUTRAL_SCAN_LIST_LIMIT = 200;

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
 * Get all active repositories on the providers the provider-neutral scan
 * covers, shaped for the source-control read primitive.
 */
async function getActiveProviderNeutralRepos(): Promise<RepositoryRow[]> {
  return db
    .select({
      id: repositories.id,
      sourceControlProvider: repositories.sourceControlProvider,
      host: repositories.host,
      installationId: repositories.installationId,
      externalRepoId: repositories.externalRepoId,
      fullName: repositories.fullName,
      htmlUrl: repositories.htmlUrl,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.isActive, true),
        inArray(repositories.sourceControlProvider, [
          ...PROVIDER_NEUTRAL_SCAN_PROVIDERS,
        ]),
      ),
    );
}

/**
 * Check if there's already an active (pending/running) conflict resolution
 * run for the given PR.
 */
async function hasActiveResolutionRun(
  repoFullName: string,
  prNumber: number,
  sourceControlProvider: SourceControlProvider,
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
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
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

  const runtime = await getAutomationRuntime('conflict_resolver');
  const frequency = runtime.enabled ? runtime.scheduleMode : 'off';

  if (!frequency || frequency === 'off') {
    result.skippedReason = 'Automation is disabled.';
    return result;
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
    return result;
  }

  const rawMaxPrAgeDays = runtime.settings.maxPrAgeDays;
  const conflictResolverMaxPrAgeDays =
    typeof rawMaxPrAgeDays === 'number' &&
    isConflictResolverMaxPrAgeDays(rawMaxPrAgeDays)
      ? rawMaxPrAgeDays
      : DEFAULT_CONFLICT_RESOLUTION_MAX_PR_AGE_DAYS;
  const conflictResolverLabel =
    typeof runtime.settings.label === 'string' && runtime.settings.label.trim()
      ? runtime.settings.label
      : DEFAULT_CONFLICT_RESOLVER_LABEL;

  const installations = await findEligibleInstallations();
  const providerNeutralRepos = await getActiveProviderNeutralRepos();

  if (installations.length === 0 && providerNeutralRepos.length === 0) {
    result.skippedReason =
      'No active GitHub installation or GitLab/Azure DevOps repositories.';
  }

  let totalCandidates = 0;
  let totalConflicting = 0;

  for (const { installationId } of installations) {
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
            if (
              await hasActiveResolutionRun(repo.fullName, pr.number, 'github')
            ) {
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

      console.log(
        `${LOG_PREFIX} Installation ${installationId}: ${candidateCount} candidates, ${conflictingCount} conflicting, ${launchedTaskCount} launched, ${notificationCount} notified`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);

      console.error(
        `${LOG_PREFIX} Error scanning installation ${installationId}:`,
        message,
      );
    }
  }

  if (providerNeutralRepos.length > 0) {
    const providerCounts = await scanProviderNeutralRepos({
      repos: providerNeutralRepos,
      conflictResolverLabel,
      conflictResolverMaxPrAgeDays,
      manualTrigger: Boolean(opts.manualTrigger),
      result,
    });

    totalCandidates += providerCounts.candidateCount;
    totalConflicting += providerCounts.conflictingCount;
  }

  // Record one combined outcome covering both the GitHub and provider-neutral
  // sections. Per-section recording let the later section overwrite the
  // earlier one — including clearing a GitHub failure from lastError when the
  // provider-neutral pass then succeeded or skipped.
  if (installations.length > 0 || providerNeutralRepos.length > 0) {
    const combinedStatus =
      result.errors.length > 0
        ? 'failed'
        : totalCandidates > 0
          ? 'succeeded'
          : 'skipped';

    await recordAutomationRunOutcome(db, {
      key: 'conflict_resolver',
      status: combinedStatus,
      at: new Date(),
      ...(combinedStatus === 'failed'
        ? { error: result.errors.join('; ') }
        : {}),
    });
  }

  console.log(
    `${LOG_PREFIX} Scan complete: ${totalCandidates} candidates, ${totalConflicting} conflicting`,
  );

  return result;
}

/**
 * Scan GitLab/Azure DevOps repositories through the provider-neutral pull
 * request primitives. Conflict detection uses the list summaries' mergeable
 * signal (GitLab `has_conflicts`) and falls back to a single-PR detail read
 * when the list payload carries none (e.g. an ADO row missing mergeStatus).
 */
async function scanProviderNeutralRepos({
  repos,
  conflictResolverLabel,
  conflictResolverMaxPrAgeDays,
  manualTrigger,
  result,
}: {
  repos: RepositoryRow[];
  conflictResolverLabel: string;
  conflictResolverMaxPrAgeDays: number;
  manualTrigger: boolean;
  result: AutomationJobResult;
}): Promise<{ candidateCount: number; conflictingCount: number }> {
  let candidateCount = 0;
  let conflictingCount = 0;
  let launchedTaskCount = 0;

  try {
    for (const repo of repos) {
      if (isRepoSkipped(repo.fullName)) {
        console.log(
          `${LOG_PREFIX} Skipping scheduled conflict scan for ${repo.fullName}`,
        );
        continue;
      }

      const provider = repo.sourceControlProvider;

      const oldestAllowedUpdatedAt = new Date();
      oldestAllowedUpdatedAt.setDate(
        oldestAllowedUpdatedAt.getDate() - DEFAULT_CONFLICT_SCAN_LOOKBACK_DAYS,
      );
      const oldestAllowedCreatedAt = new Date();
      oldestAllowedCreatedAt.setDate(
        oldestAllowedCreatedAt.getDate() - conflictResolverMaxPrAgeDays,
      );

      const listResult = await listOpenSourceControlPullRequestsForRepository({
        repository: repo,
        provider,
        limit: PROVIDER_NEUTRAL_SCAN_LIST_LIMIT,
      });

      for (const pr of listResult.pullRequests) {
        // Must have the opt-in label
        if (!pr.labels.includes(conflictResolverLabel)) {
          continue;
        }

        // Must be within the lookback window. Unlike the GitHub path (sorted
        // by updated desc, so it can break), ADO lists carry no updatedAt and
        // no update ordering, so filter each PR instead of breaking.
        if (pr.updatedAt && new Date(pr.updatedAt) < oldestAllowedUpdatedAt) {
          continue;
        }

        if (pr.createdAt && new Date(pr.createdAt) < oldestAllowedCreatedAt) {
          continue;
        }

        candidateCount++;

        // Check mergeability: trust the list signal when present, otherwise
        // fall back to a single-PR read (mirrors the GitHub per-candidate
        // detail fetch and is bounded by the same candidate set).
        let mergeable = pr.mergeable;

        if (mergeable === null) {
          const detail = await getSourceControlPullRequestDetailsForRepository({
            repository: repo,
            provider,
            prNumber: pr.number,
          });
          mergeable = detail.mergeable;
        }

        if (mergeable !== false) {
          continue;
        }

        conflictingCount++;
        console.log(
          `${LOG_PREFIX} PR ${repo.fullName}#${pr.number} has conflicts`,
        );

        // Check for existing active resolution run (dedup guard)
        if (await hasActiveResolutionRun(repo.fullName, pr.number, provider)) {
          console.log(
            `${LOG_PREFIX} Active resolution run exists for ${repo.fullName}#${pr.number} — skipping`,
          );
          continue;
        }

        const activeBranchWork = await findActiveGitHubBranchWork({
          repoFullName: repo.fullName,
          prNumber: pr.number,
          branchName: pr.sourceBranch,
          sourceControlProvider: provider,
        });

        if (activeBranchWork) {
          console.log(
            `${LOG_PREFIX} Skipping ${repo.fullName}#${pr.number} — active Roomote run ${activeBranchWork.runId} (${activeBranchWork.type}, match=${activeBranchWork.match}) is still working on the branch`,
          );
          continue;
        }

        // The recent-commit idle guard needs the head commit timestamp and
        // getCommitCommittedAt only provides that for GitHub. An unknown
        // timestamp is treated as NOT recent (matching
        // hasRecentGitHubBranchCommit's `!latestCommitAt → false`), so the
        // guard is skipped and the PR proceeds.

        try {
          const launchResult = await enqueueTask({
            task: {
              type: TaskPayloadKind.GithubPrConflictResolve,
              payload: {
                repo: repo.fullName,
                prNumber: pr.number,
                prTitle: pr.title,
                prUrl: pr.url,
                headRef: pr.sourceBranch,
                baseRef: pr.targetBranch,
                sourceControlProvider: provider,
              },
            },
            initiator: {
              kind: 'automation',
              key: 'conflict_resolver',
              ...(pr.author?.id
                ? {
                    actor: {
                      externalId: pr.author.id,
                      displayName: pr.author.login ?? undefined,
                    },
                  }
                : {}),
            },
            workflow: 'pr_conflict_resolve',
            surface: provider,
            trigger: manualTrigger ? 'manual' : 'schedule',
            prLinkage: {
              provider,
              repository: repo.fullName,
              prNumber: pr.number,
              prUrl: pr.url,
              prTitle: pr.title,
              prSha: pr.headSha ?? undefined,
              prBaseRef: pr.targetBranch,
              prBaseSha: pr.baseSha ?? undefined,
            },
          });

          launchedTaskCount++;
          result.launchedTaskId ??= launchResult.taskId;
          console.log(
            `${LOG_PREFIX} Launched conflict resolution task run ${launchResult.id} for ${repo.fullName}#${pr.number}`,
          );
          // "Working on it" PR comments are GitHub-only today; other
          // providers rely on the launched task itself for visibility.
        } catch (error) {
          console.error(
            `${LOG_PREFIX} Failed to enqueue resolution for ${repo.fullName}#${pr.number}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    result.completed = true;

    if (candidateCount === 0) {
      result.skippedReason ??= 'No labeled conflict candidates found.';
    }

    console.log(
      `${LOG_PREFIX} Provider-neutral repos: ${candidateCount} candidates, ${conflictingCount} conflicting, ${launchedTaskCount} launched`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);

    console.error(
      `${LOG_PREFIX} Error scanning provider-neutral repositories:`,
      message,
    );
  }

  return { candidateCount, conflictingCount };
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
