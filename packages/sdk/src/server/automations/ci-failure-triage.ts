import {
  buildCiFailureTriageFingerprint,
  buildCiFailureTriagePrompt,
  enqueueTask,
  findEnvironmentForRepo,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
  type CiFailureTriageTriggeringRun,
} from '@roomote/cloud-agents/server';
import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import {
  getAdoBuildFailureEvidence,
  getAdoBuildWebUrl,
  getLatestAdoBuild,
  resolveAdoInstanceHost,
  stripAdoGitRef,
} from '@roomote/ado';
import {
  getBitbucketPipelineFailureEvidence,
  getBitbucketPipelineResultName,
  getBitbucketPipelineWebUrl,
  getLatestBitbucketPipeline,
  resolveBitbucketInstanceHost,
  stripUuidBraces,
} from '@roomote/bitbucket';
import {
  getGiteaActionRunConclusion,
  getGiteaActionRunFailureEvidence,
  getGiteaActionRunWebUrl,
  getGiteaWorkflowName,
  getLatestGiteaActionRun,
  resolveGiteaInstanceHost,
} from '@roomote/gitea';
import {
  getGitLabPipelineFailureEvidence,
  getLatestGitLabPipeline,
  isNestedGitLabPipelineSource,
  resolveGitLabInstanceHost,
} from '@roomote/gitlab';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  TaskPayloadKind,
  type SourceControlProvider,
} from '@roomote/types';

import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from './destination';
import {
  findEnvironmentIdForRepositoryId,
  getActiveRepositoriesForProviders,
} from './github-deployment-scope';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[ci-failure-triage]';

/**
 * Manual "Run now" launches a single environment-backed investigate-and-fix
 * task for the first eligible repository that is free of an active claim.
 * The task focuses on the latest default-branch failure only.
 */
export async function ciFailureTriageJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting ci failure triage evaluator`);

  const result = emptyJobResult();

  if (opts.manualTrigger !== true) {
    result.skippedReason =
      'CI failure triage is webhook-driven; only manual Run now is supported offline.';
    return result;
  }

  try {
    const runtime = await getAutomationRuntime('ci_failure_triage');
    if (!runtime.enabled || runtime.scheduleMode === 'off') {
      result.skippedReason = 'Automation is disabled.';
      return result;
    }

    const connectedProviders = await listConnectedCommunicationProviders();
    const destination = await resolveAutomationRuntimeDestination({
      runtime,
      slackConnected: connectedProviders.includes('slack'),
    });

    if (!destination) {
      result.skippedReason = 'Manager channel is not configured.';
      return result;
    }

    const supportedProviders =
      (getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage')
        ?.supportedSourceControlProviders ?? [
        'github',
      ]) as SourceControlProvider[];

    const selectedRepositories =
      await getActiveRepositoriesForProviders(supportedProviders);

    if (selectedRepositories.length === 0) {
      result.skippedReason =
        'No active repositories for supported source-control providers.';
      return result;
    }

    const channelId = destination.channelId;
    let launched = 0;
    let consideredWithEnvironment = 0;
    // Resolved once on first GitLab / Azure DevOps repository; each
    // deployment holds a single credential/base URL, so only repositories on
    // that host can be inspected with it.
    let deploymentGitLabHost: string | undefined;
    let deploymentAdoHost: string | undefined;
    let deploymentBitbucketHost: string | undefined;
    let deploymentGiteaHost: string | undefined;

    // Walk every provider+host+fullName identity and resolve coverage through
    // the repository-id environment mapping (not fullName).
    for (const selectedRepository of selectedRepositories) {
      // Prefer the provider+host-scoped mapping row. Path-only fullName fallback
      // is GitHub-only so GitLab same-path hosts cannot mis-resolve workspaces.
      const mappedEnvironmentId = await findEnvironmentIdForRepositoryId(
        selectedRepository.id,
      );
      const environmentId =
        mappedEnvironmentId ??
        (selectedRepository.sourceControlProvider === 'github'
          ? await findEnvironmentForRepo(
              selectedRepository.fullName,
              undefined,
              'github',
            )
          : undefined);
      if (!environmentId) {
        continue;
      }
      consideredWithEnvironment += 1;

      const sourceControlProvider = selectedRepository.sourceControlProvider;
      let triggeringRun: CiFailureTriageTriggeringRun | undefined;
      let workflowName = 'manual-run-now';
      let headBranch = 'default';
      let claimMarker = `manual:${selectedRepository.fullName}`;

      if (sourceControlProvider === 'gitlab') {
        try {
          deploymentGitLabHost ??= await resolveGitLabInstanceHost();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to resolve the GitLab instance host (${message})`,
          );
          continue;
        }

        // Project ids are only unique per instance; querying another host's
        // repository with the deployment credential would read (and possibly
        // triage) an unrelated project. A hostless legacy row is an unknown
        // instance, so it gets the same treatment; re-syncing GitLab
        // repositories backfills `host`.
        const repositoryHost = selectedRepository.host?.trim().toLowerCase();
        if (repositoryHost !== deploymentGitLabHost) {
          console.log(
            `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: repository host ${repositoryHost ?? 'unknown'} does not match the deployment GitLab instance ${deploymentGitLabHost}`,
          );
          continue;
        }

        const projectId = selectedRepository.externalRepoId?.trim();
        if (!projectId) {
          result.errors.push(
            `${selectedRepository.fullName}: GitLab project id is unavailable`,
          );
          continue;
        }

        try {
          const latestPipeline = await getLatestGitLabPipeline({
            projectId,
            ref: selectedRepository.defaultBranch,
          });

          if (
            !latestPipeline ||
            latestPipeline.status.toLowerCase() !== 'failed'
          ) {
            console.log(
              `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: latest GitLab default-branch pipeline is not failed`,
            );
            continue;
          }

          if (isNestedGitLabPipelineSource(latestPipeline.source)) {
            console.log(
              `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: latest GitLab pipeline source is nested/child (${latestPipeline.source})`,
            );
            continue;
          }

          const failureEvidence = await getGitLabPipelineFailureEvidence({
            projectId,
            pipelineId: latestPipeline.id,
          });
          workflowName = latestPipeline.name?.trim() || 'pipeline';
          headBranch = latestPipeline.ref;
          claimMarker = latestPipeline.web_url;
          triggeringRun = {
            repositoryFullName: selectedRepository.fullName,
            workflowName,
            runUrl: latestPipeline.web_url,
            headBranch,
            headSha: latestPipeline.sha,
            provider: 'gitlab',
            failureEvidence,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to inspect GitLab pipeline (${message})`,
          );
          continue;
        }
      }

      if (sourceControlProvider === 'ado') {
        try {
          deploymentAdoHost ??= await resolveAdoInstanceHost();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to resolve the Azure DevOps instance host (${message})`,
          );
          continue;
        }

        const repositoryHost = selectedRepository.host?.trim().toLowerCase();
        if (repositoryHost !== deploymentAdoHost) {
          console.log(
            `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: repository host ${repositoryHost ?? 'unknown'} does not match the deployment Azure DevOps instance ${deploymentAdoHost}`,
          );
          continue;
        }

        const repositoryId = selectedRepository.externalRepoId?.trim();
        if (!repositoryId) {
          result.errors.push(
            `${selectedRepository.fullName}: Azure DevOps repository id is unavailable`,
          );
          continue;
        }

        try {
          const latestBuild = await getLatestAdoBuild({
            repositoryFullName: selectedRepository.fullName,
            repositoryId,
            branch: selectedRepository.defaultBranch,
          });

          if (
            !latestBuild ||
            (latestBuild.result ?? '').toLowerCase() !== 'failed'
          ) {
            console.log(
              `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: latest Azure DevOps default-branch build is not failed`,
            );
            continue;
          }

          const failureEvidence = await getAdoBuildFailureEvidence({
            repositoryFullName: selectedRepository.fullName,
            buildId: latestBuild.id,
          });
          workflowName =
            latestBuild.definition?.name?.trim() ||
            (latestBuild.buildNumber
              ? `build ${latestBuild.buildNumber}`
              : 'build');
          headBranch =
            stripAdoGitRef(latestBuild.sourceBranch) ||
            stripAdoGitRef(selectedRepository.defaultBranch) ||
            'main';
          claimMarker = getAdoBuildWebUrl(latestBuild);
          triggeringRun = {
            repositoryFullName: selectedRepository.fullName,
            workflowName,
            runUrl: getAdoBuildWebUrl(latestBuild),
            headBranch,
            headSha: (latestBuild.sourceVersion ?? '').trim() || 'unknown',
            provider: 'ado',
            failureEvidence,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to inspect Azure DevOps build (${message})`,
          );
          continue;
        }
      }

      if (sourceControlProvider === 'bitbucket') {
        try {
          deploymentBitbucketHost ??= await resolveBitbucketInstanceHost();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to resolve the Bitbucket instance host (${message})`,
          );
          continue;
        }

        const repositoryHost = selectedRepository.host?.trim().toLowerCase();
        if (repositoryHost !== deploymentBitbucketHost) {
          console.log(
            `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: repository host ${repositoryHost ?? 'unknown'} does not match the deployment Bitbucket instance ${deploymentBitbucketHost}`,
          );
          continue;
        }

        try {
          const latestPipeline = await getLatestBitbucketPipeline({
            repositoryFullName: selectedRepository.fullName,
            branch: selectedRepository.defaultBranch,
          });
          const resultName = latestPipeline
            ? getBitbucketPipelineResultName(latestPipeline)
            : '';

          if (
            !latestPipeline ||
            (resultName !== 'FAILED' && resultName !== 'ERROR')
          ) {
            console.log(
              `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: latest Bitbucket default-branch pipeline is not failed`,
            );
            continue;
          }

          const failureEvidence = await getBitbucketPipelineFailureEvidence({
            repositoryFullName: selectedRepository.fullName,
            pipelineUuid: stripUuidBraces(latestPipeline.uuid),
          });
          workflowName =
            latestPipeline.target?.selector?.pattern?.trim() ||
            latestPipeline.target?.selector?.type?.trim() ||
            (latestPipeline.build_number !== undefined
              ? `pipeline ${latestPipeline.build_number}`
              : 'pipeline');
          headBranch =
            (latestPipeline.target?.ref_name ?? '')
              .replace(/^refs\/heads\//, '')
              .trim() ||
            selectedRepository.defaultBranch ||
            'main';
          const runUrl = getBitbucketPipelineWebUrl({
            repositoryFullName: selectedRepository.fullName,
            pipeline: latestPipeline,
          });
          claimMarker = runUrl;
          triggeringRun = {
            repositoryFullName: selectedRepository.fullName,
            workflowName,
            runUrl,
            headBranch,
            headSha:
              (latestPipeline.target?.commit?.hash ?? '').trim() || 'unknown',
            provider: 'bitbucket',
            failureEvidence,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to inspect Bitbucket pipeline (${message})`,
          );
          continue;
        }
      }

      if (sourceControlProvider === 'gitea') {
        try {
          deploymentGiteaHost ??= await resolveGiteaInstanceHost();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to resolve the Gitea instance host (${message})`,
          );
          continue;
        }

        // Run ids and host path uniqueness are instance-scoped; only inspect
        // repositories that match the deployment Gitea base URL host.
        const repositoryHost = selectedRepository.host?.trim().toLowerCase();
        if (repositoryHost !== deploymentGiteaHost) {
          console.log(
            `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: repository host ${repositoryHost ?? 'unknown'} does not match the deployment Gitea instance ${deploymentGiteaHost}`,
          );
          continue;
        }

        try {
          const latestRun = await getLatestGiteaActionRun({
            repositoryFullName: selectedRepository.fullName,
            branch: selectedRepository.defaultBranch,
          });
          const conclusion = latestRun
            ? getGiteaActionRunConclusion(latestRun)
            : '';

          if (
            !latestRun ||
            (conclusion !== 'failure' && conclusion !== 'failed')
          ) {
            console.log(
              `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: latest Gitea default-branch Actions run is not failed`,
            );
            continue;
          }

          const failureEvidence = await getGiteaActionRunFailureEvidence({
            repositoryFullName: selectedRepository.fullName,
            runId: latestRun.id,
          }).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            console.log(
              `${LOG_PREFIX} Gitea Actions evidence unavailable for ${selectedRepository.fullName}: ${message}`,
            );
            return null;
          });
          workflowName = getGiteaWorkflowName(latestRun);
          headBranch =
            (latestRun.head_branch ?? '')
              .replace(/^refs\/heads\//, '')
              .trim() ||
            selectedRepository.defaultBranch ||
            'main';
          const runUrl = getGiteaActionRunWebUrl({
            repositoryFullName: selectedRepository.fullName,
            run: latestRun,
          });
          claimMarker = runUrl;
          triggeringRun = {
            repositoryFullName: selectedRepository.fullName,
            workflowName,
            runUrl,
            headBranch,
            headSha: (latestRun.head_sha ?? '').trim() || 'unknown',
            provider: 'gitea',
            failureEvidence,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(
            `${selectedRepository.fullName}: failed to inspect Gitea Actions run (${message})`,
          );
          continue;
        }
      }

      // Repo claim blocks double-start against an active webhook investigation.
      const fingerprint = buildCiFailureTriageFingerprint({
        repositoryFullName: selectedRepository.fullName,
        workflowName,
        headBranch,
        repositoryHost: selectedRepository.host,
        provider: sourceControlProvider,
      });
      const claimed = await tryClaimCiFailureTriageInvestigation({
        provider: sourceControlProvider,
        repositoryFullName: selectedRepository.fullName,
        repositoryHost: selectedRepository.host,
        fingerprint,
        marker: claimMarker,
      });

      if (!claimed) {
        console.log(
          `${LOG_PREFIX} Skipping ${selectedRepository.fullName}: active investigation claim`,
        );
        continue;
      }

      const coverageSlice = [
        {
          repositoryFullName: selectedRepository.fullName,
          targetEnvironmentId: environmentId,
        },
      ];

      try {
        const launchResult = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.StandardTask,
              payload: {
                repo: selectedRepository.fullName,
                environmentId,
                selectedRepositories: [selectedRepository.fullName],
                ...(sourceControlProvider !== 'github'
                  ? { sourceControlProvider }
                  : {}),
                ...(sourceControlProvider !== 'github' &&
                selectedRepository.host
                  ? { sourceControlHost: selectedRepository.host }
                  : {}),
                description: buildCiFailureTriagePrompt({
                  channelId,
                  repositoryFullNames: [selectedRepository.fullName],
                  repositoryCoverage: coverageSlice,
                  trigger: 'manual',
                  destinationProvider: destination.provider,
                  sourceControlProvider,
                  triggeringRun,
                }),
                ...buildDestinationTaskPayloadFields(destination),
                visibleInTranscript: false,
              },
            },
            initiator: { kind: 'automation', key: 'ci_failure_triage' },
            workflow: 'standard',
            surface: 'system',
            trigger: 'manual',
            visibility: 'hidden',
            ...(destination.provider === 'slack'
              ? { channels: { slackChannelId: channelId } }
              : {}),
          },
          { launchClass: 'automation' },
        );

        result.launchedTaskId = launchResult.taskId;
        launched = 1;
        // One failure at a time — do not fan out.
        break;
      } catch (enqueueError) {
        await releaseCiFailureTriageInvestigation({
          provider: sourceControlProvider,
          repositoryFullName: selectedRepository.fullName,
          repositoryHost: selectedRepository.host,
          fingerprint,
        }).catch(() => undefined);
        const message =
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError);
        result.errors.push(
          `${selectedRepository.fullName}: failed to launch (${message})`,
        );
        console.error(
          `${LOG_PREFIX} Failed to launch for ${selectedRepository.fullName}: ${message}`,
        );
      }
    }

    if (consideredWithEnvironment === 0 && launched === 0) {
      result.skippedReason =
        'no repositories are covered by a configured environment';
    }

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'succeeded',
      at: new Date(),
    });

    if (launched === 0 && !result.skippedReason) {
      result.skippedReason =
        result.errors.length > 0
          ? 'Failed to launch the CI failure fix task.'
          : 'No CI failure fix task was launched (no eligible repo or claim held).';
    }

    console.log(
      `${LOG_PREFIX} Manual Run now launched ${launched} task for latest failure focus`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch(() => undefined);
    console.error(`${LOG_PREFIX} Failed: ${message}`);
    return result;
  }
}
