import pMap from 'p-map';

import {
  type TaskPayload,
  DEFAULT_PR_REVIEW_SETTINGS,
  type PrReviewSettings,
  TaskPayloadKind,
  RunStatus,
  exitedRunStatuses,
  isExitedRunStatus,
} from '@roomote/types';
import {
  db,
  taskPullRequests,
  taskRuns,
  tasks,
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  sql,
} from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  acquireGithubPrReviewLifecycleLock,
  enqueueActivePrReviewFollowUp,
  publishGithubPrReviewCheck,
} from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { toHostFromUrl } from '../utils';

import type { WebhookPullRequestSynchronize } from './types';
import { getGitHubAutomationTargets } from './getGitHubAutomationTargets';
import { getBackgroundGithubTaskProperties } from './backgroundGithubTaskProperties';
import { getCurrentGitHubPrHeadSha } from './currentPrHead';
import { getReviewTaskRelayPayload } from './reviewTaskRelayPayload';

async function findActiveReviewRun(repository: string, prNumber: number) {
  const [activeRun] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      status: taskRuns.status,
      startedAt: taskRuns.startedAt,
      sandboxServerUrl: taskRuns.sandboxServerUrl,
      prSha: taskPullRequests.prSha,
      payload: taskRuns.payload,
    })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
        not(
          inArray(taskRuns.status, exitedRunStatuses as unknown as RunStatus[]),
        ),
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  return activeRun;
}

async function findCompletedSameHeadReviewRun(
  repository: string,
  prNumber: number,
  headSha: string,
) {
  const [completedRun] = await db
    .select({ id: taskRuns.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
        sql`${taskRuns.payload}->>'headSha' = ${headSha}`,
        eq(taskRuns.status, RunStatus.Completed),
        isNotNull(taskRuns.startedAt),
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);

  return completedRun;
}

async function findExistingReviewTask(repository: string, prNumber: number) {
  const [existingTask] = await db
    .select({ taskId: tasks.id })
    .from(tasks)
    .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  return existingTask;
}

export async function handlePrSynchronize({
  installation,
  repository,
  pull_request: pr,
  sender,
}: WebhookPullRequestSynchronize): Promise<WebhookResponse> {
  if (pr.locked) {
    return { status: 'error', message: 'PR is locked' };
  }

  const result = await getGitHubAutomationTargets({
    workflow: 'pr_review',
    installation,
    repository,
    sender,
    author: pr.user?.login?.toLowerCase(),
  });

  if (result.status === 'error') {
    return result;
  }

  const { targets: allTargets } = result;

  const targets = allTargets.filter((target) => {
    const settings = target.settings as PrReviewSettings | null;
    const reviewOnCommit =
      settings?.reviewOnCommit ?? DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit;
    const reviewDraftPrs =
      settings?.reviewDraftPrs ?? DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs;

    if (!reviewOnCommit) {
      return false;
    }

    return !pr.draft || reviewDraftPrs;
  });

  const target = targets[0];
  let skippedCompletedHead = false;
  let queuedActiveReviewFollowUp = false;

  if (!target) {
    return { status: 'ok', message: 'No PR reviewer targets found.' };
  }

  const enqueued = await pMap(targets, async (currentTarget) => {
    const releaseLaunchLock = await acquireGithubPrReviewLifecycleLock(
      repository.full_name,
      pr.number,
    );

    if (!releaseLaunchLock) {
      throw new Error(
        `Timed out serializing PR review launch for ${repository.full_name}#${pr.number}`,
      );
    }

    try {
      releaseLaunchLock.signal.throwIfAborted();
      const headSha = await getCurrentGitHubPrHeadSha({
        installationId: installation!.id,
        repository: repository.full_name,
        prNumber: pr.number,
      });

      if (!headSha) {
        throw new Error(
          `Could not resolve the live head for ${repository.full_name}#${pr.number}.`,
        );
      }

      const activeReviewRun = await findActiveReviewRun(
        repository.full_name,
        pr.number,
      );

      if (activeReviewRun) {
        if (activeReviewRun.prSha === headSha) {
          console.log(
            `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> skip_active_review_same_head (target: ${currentTarget.id})`,
          );

          return null;
        }

        let followUpRun =
          activeReviewRun.startedAt && activeReviewRun.sandboxServerUrl
            ? activeReviewRun
            : null;
        let reconciliation: 'pending_updated' | 'terminal' = 'pending_updated';

        if (!followUpRun) {
          const result = await db.transaction(async (tx) => {
            const canonicalKey = `github:${repository.full_name}:${pr.number}`;
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonicalKey}, 0))`,
            );
            await tx.execute(
              sql`SELECT id FROM task_runs WHERE id = ${activeReviewRun.id} FOR UPDATE`,
            );

            const lockedRun = await tx.query.taskRuns.findFirst({
              where: eq(taskRuns.id, activeReviewRun.id),
              columns: {
                id: true,
                taskId: true,
                status: true,
                startedAt: true,
                sandboxServerUrl: true,
                payload: true,
              },
            });

            if (!lockedRun || isExitedRunStatus(lockedRun.status)) {
              return { kind: 'terminal' as const };
            }

            if (lockedRun.startedAt && lockedRun.sandboxServerUrl) {
              return { kind: 'follow_up' as const, run: lockedRun };
            }

            await tx
              .update(taskPullRequests)
              .set({ prSha: headSha })
              .where(eq(taskPullRequests.taskId, lockedRun.taskId));
            await tx
              .update(taskRuns)
              .set({
                payload: {
                  ...lockedRun.payload,
                  headSha,
                  branchName: pr.head.ref,
                  prTitle: pr.title,
                  prUrl: pr.html_url,
                },
              })
              .where(eq(taskRuns.id, lockedRun.id));

            return { kind: 'pending_updated' as const };
          });

          if (result.kind === 'follow_up') {
            followUpRun = {
              ...activeReviewRun,
              ...result.run,
              prSha: activeReviewRun.prSha,
            };
          } else {
            reconciliation = result.kind;
          }
        }

        if (followUpRun) {
          // Record the superseding head before the debounced follow-up is
          // queued. `prSha` stays the head this review last covered because
          // it seeds `previous_review_head_sha` in the follow-up prompt, so
          // the newest observed head needs its own field for a review that
          // finishes before the relay lands.
          await db
            .update(taskRuns)
            .set({
              payload: sql`coalesce(${taskRuns.payload}, '{}'::jsonb) || jsonb_build_object('latestObservedHeadSha', ${headSha}::text)`,
            })
            .where(eq(taskRuns.id, followUpRun.id));

          const relayPayload = await getReviewTaskRelayPayload({
            repository: repository.full_name,
            prNumber: pr.number,
            branchName: pr.head.ref,
            prBody: pr.body ?? null,
            reviewerSettings: currentTarget.settings,
          });

          await enqueueActivePrReviewFollowUp({
            runId: followUpRun.id,
            taskId: followUpRun.taskId,
            sandboxServerUrl: followUpRun.sandboxServerUrl!,
            repository: repository.full_name,
            prNumber: pr.number,
            previousHeadSha: followUpRun.prSha,
            eventHeadSha: headSha,
            fallback: {
              task: {
                type: TaskPayloadKind.GithubPrReviewSync,
                ...getBackgroundGithubTaskProperties(currentTarget.properties),
                payload: {
                  repo: repository.full_name,
                  prNumber: pr.number,
                  prTitle: pr.title,
                  prUrl: pr.html_url,
                  headSha,
                  branchName: pr.head.ref,
                  ...relayPayload,
                },
              },
              initiatorActor: {
                externalId: String(sender.id),
                displayName: sender.login,
              },
              prLinkage: {
                provider: 'github',
                host:
                  currentTarget.repo.host ??
                  toHostFromUrl(pr.html_url) ??
                  'github.com',
                repositoryId: currentTarget.repo.id,
                repository: repository.full_name,
                prNumber: pr.number,
                prUrl: pr.html_url,
                prTitle: pr.title,
                prSha: headSha,
                prBaseRef: pr.base?.ref ?? null,
                prBaseSha: pr.base?.sha ?? null,
              },
            },
          });
          if (currentTarget.settings?.publishGithubCheck) {
            releaseLaunchLock.signal.throwIfAborted();
            await publishGithubPrReviewCheck({
              installationId: installation!.id,
              repository: repository.full_name,
              prNumber: pr.number,
              headSha,
              taskId: followUpRun.taskId,
              runId: followUpRun.id,
              status: 'in_progress',
              signal: releaseLaunchLock.signal,
            });
          }
          queuedActiveReviewFollowUp = true;
        }

        if (reconciliation !== 'terminal') {
          console.log(
            `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> ${
              followUpRun
                ? 'queue_active_review_follow_up'
                : 'update_pending_review_head'
            } (target: ${currentTarget.id})`,
          );

          return null;
        }
      }

      const completedSameHeadRun = await findCompletedSameHeadReviewRun(
        repository.full_name,
        pr.number,
        headSha,
      );

      if (completedSameHeadRun) {
        skippedCompletedHead = true;
        console.log(
          `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> skip_already_reviewed_head (target: ${currentTarget.id})`,
        );

        return null;
      }

      const existingReviewTask = await findExistingReviewTask(
        repository.full_name,
        pr.number,
      );
      const shouldRunSyncReview = !!existingReviewTask;

      console.log(
        `[handlePrSynchronize] ${repository.full_name}#${pr.number} -> ${
          shouldRunSyncReview ? 'sync_review' : 'initial_review'
        } (target: ${currentTarget.id})`,
      );

      const relayPayload = await getReviewTaskRelayPayload({
        repository: repository.full_name,
        prNumber: pr.number,
        branchName: pr.head.ref,
        prBody: pr.body ?? null,
        reviewerSettings: currentTarget.settings,
      });

      const launch = await enqueueTask({
        existingTaskId: existingReviewTask?.taskId,
        task: {
          type: shouldRunSyncReview
            ? TaskPayloadKind.GithubPrReviewSync
            : TaskPayloadKind.GithubPrReview,
          ...getBackgroundGithubTaskProperties(currentTarget.properties),
          payload: {
            repo: repository.full_name,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            headSha,
            branchName: pr.head.ref,
            ...relayPayload,
          } satisfies TaskPayload<
            | typeof TaskPayloadKind.GithubPrReviewSync
            | typeof TaskPayloadKind.GithubPrReview
          >,
        },
        initiator: {
          kind: 'automation',
          key: 'review_code',
          actor: {
            externalId: String(sender.id),
            displayName: sender.login,
          },
        },
        workflow: 'pr_review',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: {
          provider: 'github',
          host: target.repo.host ?? toHostFromUrl(pr.html_url) ?? 'github.com',
          repositoryId: target.repo.id,
          repository: repository.full_name,
          prNumber: pr.number,
          prUrl: pr.html_url,
          prTitle: pr.title,
          prSha: headSha,
          prBaseRef: pr.base?.ref ?? null,
          prBaseSha: pr.base?.sha ?? null,
        },
      });

      if (currentTarget.settings?.publishGithubCheck) {
        releaseLaunchLock.signal.throwIfAborted();
        await publishGithubPrReviewCheck({
          installationId: installation!.id,
          repository: repository.full_name,
          prNumber: pr.number,
          headSha,
          taskId: launch.taskId,
          runId: launch.id,
          signal: releaseLaunchLock.signal,
        });
      }

      return launch;
    } finally {
      await releaseLaunchLock();
    }
  });

  const ids = enqueued.flatMap((job) => (job ? [job.id] : []));

  if (ids.length === 0) {
    return {
      status: 'ok',
      message: queuedActiveReviewFollowUp
        ? 'Queued new PR changes on the active review.'
        : skippedCompletedHead
          ? 'PR head SHA already matches the latest reviewed SHA.'
          : 'A PR review is already active.',
    };
  }

  return { status: 'ok', metadata: { ids } };
}
