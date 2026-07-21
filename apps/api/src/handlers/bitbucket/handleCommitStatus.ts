import type { FailedCiRun } from '@roomote/cloud-agents/server';
import {
  getBitbucketPipeline,
  getBitbucketPipelineByBuildNumber,
  getBitbucketPipelineFailureEvidence,
  getBitbucketPipelineResultName,
  getBitbucketPipelineWebUrl,
  stripUuidBraces,
} from '@roomote/bitbucket';
import { and, db, eq, or, repositories } from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '@roomote/sdk/server';

import { logApiError } from '../../logging';
import type { WebhookResponse } from '../../types';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import type { BitbucketCommitStatusWebhook } from './types';

function stripGitRef(refName: string | null | undefined): string {
  return (refName ?? '').trim().replace(/^refs\/heads\//, '');
}

/**
 * Parse a Bitbucket Pipelines results URL into build number or UUID.
 * Examples:
 * - .../addon/pipelines/home#!/results/42
 * - .../pipelines/results/{uuid}
 */
export function parseBitbucketPipelineIdentityFromUrl(
  url: string | null | undefined,
): { buildNumber?: number; pipelineUuid?: string } {
  const href = (url ?? '').trim();
  if (!href) {
    return {};
  }

  // UUID segments can start with hex digits; match them before bare build
  // numbers so ".../results/01234567-89ab-..." is not treated as 1234567.
  // Require a Pipelines path so external CI URLs are not treated as Pipeline ids.
  const uuidMatch = href.match(
    /pipelines\/(?:results\/|home#!\/results\/)(\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?)/i,
  );
  if (uuidMatch?.[1]) {
    return { pipelineUuid: stripUuidBraces(uuidMatch[1]) };
  }

  // Require a Pipelines path segment so external CI URLs that happen to
  // contain "/results/<n>" are not treated as Pipeline identities.
  const buildMatch =
    href.match(
      /pipelines\/(?:home#!\/*results\/|results\/)(\d+)(?:\b|[/?#]|$)/i,
    ) || href.match(/addon\/pipelines\/[^#]*#!\/results\/(\d+)(?:\b|[/?#]|$)/i);
  if (buildMatch?.[1]) {
    return { buildNumber: Number(buildMatch[1]) };
  }

  return {};
}

/**
 * Bitbucket adapter: map failed default-branch Pipelines commit statuses into
 * FailedCiRun and hand off to the shared CI failure triage launch core.
 *
 * Bitbucket Cloud surfaces Pipeline completion as repo:commit_status_* events.
 * Those events also cover external CI (Jenkins, etc.), so only launch when the
 * status URL identifies a Pipelines run that resolves via the Bitbucket API.
 */
export async function handleBitbucketCommitStatus(
  payload: BitbucketCommitStatusWebhook,
): Promise<WebhookResponse> {
  const status = payload.commit_status;
  const state = (status.state ?? '').trim().toUpperCase();
  if (state !== 'FAILED') {
    return {
      status: 'ok',
      message: `Ignoring non-failure Bitbucket commit status: ${status.state ?? 'unknown'}`,
    };
  }

  const identity = parseBitbucketPipelineIdentityFromUrl(status.url);
  if (
    identity.pipelineUuid === undefined &&
    identity.buildNumber === undefined
  ) {
    return {
      status: 'ok',
      message:
        'Ignoring failed Bitbucket commit status that is not a Pipelines result URL',
    };
  }

  const externalRepoId = payload.repository.uuid
    ? stripUuidBraces(payload.repository.uuid)
    : payload.repository.id !== undefined
      ? String(payload.repository.id).replace(/^\{|\}$/g, '')
      : null;
  const fullName = payload.repository.full_name?.trim();
  if (!externalRepoId && !fullName) {
    return {
      status: 'ok',
      message: 'Ignoring Bitbucket commit status without a repository identity',
    };
  }

  // Prefer repository HTML links so external CI hosts (Jenkins, etc.) do not
  // break host-scoped repository matching before pipeline resolution.
  const webhookHost = toHostFromUrl(
    payload.repository.links?.html?.href ??
      status.links?.self?.href ??
      status.url ??
      '',
  );

  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'bitbucket'),
      eq(repositories.isActive, true),
      fullName && externalRepoId
        ? or(
            eq(repositories.externalRepoId, externalRepoId),
            eq(repositories.fullName, fullName),
          )
        : externalRepoId
          ? eq(repositories.externalRepoId, externalRepoId)
          : eq(repositories.fullName, fullName!),
    ),
  });
  const repo = pickHostScopedRepository(repoRows, webhookHost);

  if (!repo) {
    return {
      status: 'ok',
      message: `No active Bitbucket repository for [${externalRepoId ?? 'unknown'}, ${fullName ?? 'unknown'}]`,
    };
  }

  const defaultBranch = stripGitRef(repo.defaultBranch) || 'main';
  let headBranch = stripGitRef(status.refname);
  let headSha = (status.commit?.hash ?? '').trim();
  let pipelineUuid = identity.pipelineUuid;
  let buildNumber = identity.buildNumber;
  let runUrl = (status.url ?? '').trim();
  let workflowName = (status.name ?? '').trim() || 'pipeline';

  let pipeline = null;
  try {
    pipeline =
      pipelineUuid !== undefined
        ? await getBitbucketPipeline({
            repositoryFullName: repo.fullName,
            pipelineUuid,
          })
        : await getBitbucketPipelineByBuildNumber({
            repositoryFullName: repo.fullName,
            branch: headBranch || defaultBranch,
            buildNumber: buildNumber!,
          });

    // If build-number lookup used status ref and missed, retry on default branch.
    if (
      !pipeline &&
      buildNumber !== undefined &&
      headBranch !== defaultBranch
    ) {
      pipeline = await getBitbucketPipelineByBuildNumber({
        repositoryFullName: repo.fullName,
        branch: defaultBranch,
        buildNumber,
      });
    }
  } catch (error) {
    logApiError(
      `[Bitbucket] Failed to inspect pipeline for status ${status.key ?? status.name ?? 'unknown'}`,
      error,
    );
    return {
      status: 'ok',
      message:
        'Ignoring failed Bitbucket commit status that could not be resolved to a Pipeline',
    };
  }

  if (!pipeline) {
    return {
      status: 'ok',
      message:
        'Ignoring failed Bitbucket commit status that could not be resolved to a Pipeline',
    };
  }

  const result = getBitbucketPipelineResultName(pipeline);
  if (result !== 'FAILED' && result !== 'ERROR') {
    return {
      status: 'ok',
      message: `Ignoring Bitbucket pipeline that is not failed: ${result || 'unknown'}`,
    };
  }

  headBranch =
    stripGitRef(pipeline.target?.ref_name) || headBranch || defaultBranch;
  headSha = (pipeline.target?.commit?.hash ?? headSha).trim();
  pipelineUuid = stripUuidBraces(pipeline.uuid);
  buildNumber = pipeline.build_number ?? buildNumber;
  runUrl = getBitbucketPipelineWebUrl({
    repositoryFullName: repo.fullName,
    pipeline,
  });
  workflowName =
    pipeline.target?.selector?.pattern?.trim() ||
    pipeline.target?.selector?.type?.trim() ||
    workflowName;

  if (!headBranch) {
    return {
      status: 'ok',
      message: 'Ignoring Bitbucket commit status without a branch ref',
    };
  }

  if (headBranch !== defaultBranch) {
    return {
      status: 'ok',
      message: 'Ignoring Bitbucket pipeline outside the default branch',
    };
  }

  if (!headSha) {
    return {
      status: 'ok',
      message: 'Ignoring Bitbucket pipeline without a head SHA',
    };
  }

  if (!runUrl) {
    runUrl = getBitbucketPipelineWebUrl({
      repositoryFullName: repo.fullName,
      pipeline: {
        uuid: pipelineUuid ? `{${pipelineUuid}}` : '{unknown}',
        build_number: buildNumber,
      },
    });
  }

  const failureEvidence = await getBitbucketPipelineFailureEvidence({
    repositoryFullName: repo.fullName,
    pipelineUuid,
  }).catch((error) => {
    logApiError(
      `[Bitbucket] Failed to fetch pipeline evidence for ${pipelineUuid}`,
      error,
    );
    return null;
  });

  const failedRun: FailedCiRun = {
    provider: 'bitbucket',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    repositoryHost: repo.host,
    externalRepoId: repo.externalRepoId,
    defaultBranch,
    headBranch,
    headSha,
    workflowOrPipelineName: workflowName,
    runId: pipelineUuid ?? String(buildNumber),
    runUrl,
    ...(failureEvidence ? { failureEvidence } : {}),
  };

  return launchCiFailureTriageForFailedRun(failedRun);
}
