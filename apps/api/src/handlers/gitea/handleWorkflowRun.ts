import type { FailedCiRun } from '@roomote/cloud-agents/server';
import {
  getGiteaActionRunConclusion,
  getGiteaActionRunFailureEvidence,
  getGiteaActionRunWebUrl,
  getGiteaWorkflowName,
} from '@roomote/gitea';
import { and, db, eq, or, repositories } from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '@roomote/sdk/server';

import { logApiError } from '../../logging';
import type { WebhookResponse } from '../../types';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import type { GiteaWorkflowRunWebhook } from './types';

function stripGitRef(refName: string | null | undefined): string {
  return (refName ?? '').trim().replace(/^refs\/heads\//, '');
}

/**
 * Gitea adapter: map failed default-branch Actions workflow_run events into
 * FailedCiRun and hand off to the shared CI failure triage launch core.
 *
 * Gitea's Actions surface uses GitHub-compatible `workflow_run` webhooks. Non-
 * completed / non-failure conclusions are ignored (fail-closed for non-Actions
 * noise).
 */
export async function handleGiteaWorkflowRun(
  payload: GiteaWorkflowRunWebhook,
): Promise<WebhookResponse> {
  const action = (payload.action ?? '').trim().toLowerCase();
  if (action && action !== 'completed') {
    return {
      status: 'ok',
      message: `Ignoring non-completed Gitea workflow_run action: ${payload.action ?? 'unknown'}`,
    };
  }

  const run = payload.workflow_run;
  if (!run) {
    return {
      status: 'ok',
      message: 'Ignoring Gitea workflow_run without a run payload',
    };
  }

  const conclusion = getGiteaActionRunConclusion(run);
  if (conclusion !== 'failure' && conclusion !== 'failed') {
    return {
      status: 'ok',
      message: `Ignoring non-failure Gitea Actions run: ${run.conclusion ?? run.status ?? 'unknown'}`,
    };
  }

  const externalRepoId = String(payload.repository.id);
  const fullName = payload.repository.full_name?.trim();
  if (!fullName) {
    return {
      status: 'ok',
      message: 'Ignoring Gitea workflow_run without a repository full name',
    };
  }

  const webhookHost = toHostFromUrl(
    run.html_url ??
      payload.repository.html_url ??
      payload.workflow?.html_url ??
      '',
  );

  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'gitea'),
      eq(repositories.isActive, true),
      or(
        eq(repositories.externalRepoId, externalRepoId),
        eq(repositories.fullName, fullName),
      ),
    ),
  });
  const repo = pickHostScopedRepository(repoRows, webhookHost);

  if (!repo) {
    return {
      status: 'ok',
      message: `No active Gitea repository for [${externalRepoId}, ${fullName}]`,
    };
  }

  const defaultBranch =
    stripGitRef(repo.defaultBranch) ||
    stripGitRef(
      (payload.repository as { default_branch?: string }).default_branch,
    ) ||
    'main';
  const headBranch = stripGitRef(run.head_branch);
  if (!headBranch) {
    return {
      status: 'ok',
      message: 'Ignoring Gitea Actions run without a head branch',
    };
  }

  if (headBranch !== defaultBranch) {
    return {
      status: 'ok',
      message: 'Ignoring Gitea Actions run outside the default branch',
    };
  }

  const headSha = (run.head_sha ?? '').trim();
  if (!headSha) {
    return {
      status: 'ok',
      message: 'Ignoring Gitea Actions run without a head SHA',
    };
  }

  const workflowName =
    (payload.workflow?.name ?? '').trim() ||
    (payload.workflow?.path ?? '').trim() ||
    getGiteaWorkflowName(run);

  const runUrl = getGiteaActionRunWebUrl({
    repositoryFullName: repo.fullName,
    run,
  });

  const failureEvidence = await getGiteaActionRunFailureEvidence({
    repositoryFullName: repo.fullName,
    runId: run.id,
  }).catch((error) => {
    logApiError(
      `[Gitea] Failed to fetch Actions evidence for run ${run.id}`,
      error,
    );
    return null;
  });

  const failedRun: FailedCiRun = {
    provider: 'gitea',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    repositoryHost: repo.host,
    externalRepoId: repo.externalRepoId ?? externalRepoId,
    defaultBranch,
    headBranch,
    headSha,
    workflowOrPipelineName: workflowName,
    runId: String(run.id),
    runUrl,
    ...(failureEvidence ? { failureEvidence } : {}),
  };

  return launchCiFailureTriageForFailedRun(failedRun);
}
