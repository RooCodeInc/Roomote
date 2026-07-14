import { getRedis } from '@roomote/redis';
import {
  buildCiFailureTriagePrompt,
  buildRepositoryCoverage,
  enqueueTask,
  getTaskUrl,
  tryClaimCiFailureTriageFingerprint,
  buildCiFailureTriageFingerprint,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getBackgroundAgentSettingsForDeployment,
  githubInstallations,
  recordAutomationRunOutcome,
  repositories,
  upsertBackgroundAutomationSlackThread,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  getTriggerableBackgroundAutomationDescriptorByKey,
  type SlackBlock,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { resolveAutomationSlackTarget } from '../tasks/automation-work-items/slack.js';
import {
  buildAutomationRootFooterBlocks,
  refreshAutomationRootFooter,
} from '../tasks/automation-slack-root-footer.js';
import { resolveScheduledSuggestionSlackConfig } from '../tasks/background-automation-slack.js';

const LOG_PREFIX = '[handleWorkflowRunCompleted]';

// A broken default branch usually fails several workflows within minutes;
// one investigation per repository covers the burst.
const TRIAGE_DEBOUNCE_SECONDS = 15 * 60;

// Bounds how far back the task correlates run history for classification.
const WEBHOOK_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

interface WorkflowRunCompletedPayload {
  action: string;
  workflow_run: {
    id: number;
    name?: string | null;
    conclusion: string | null;
    head_branch: string | null;
    head_sha: string;
    html_url: string;
    event: string;
  };
  workflow?: { name?: string | null } | null;
  repository: {
    id: number;
    full_name: string;
    default_branch: string;
  };
  installation?: { id: number } | null;
}

function buildTriageDebounceKey(repositoryId: string): string {
  return `github:ci-failure-triage:${repositoryId}`;
}

function buildAnnouncementText(params: {
  repositoryFullName: string;
  defaultBranch: string;
  workflowName: string;
  runUrl: string;
  headSha: string;
}): string {
  return [
    `I noticed a CI failure on \`${params.defaultBranch}\` in ${params.repositoryFullName}.`,
    `The \`${params.workflowName}\` workflow failed in [run \`${params.headSha.slice(0, 7)}\`](${params.runUrl}), and I'm looking into it now. I'll report back here.`,
  ].join('\n');
}

type AnnouncementSlackTarget = Awaited<
  ReturnType<typeof resolveAutomationSlackTarget>
>;

/**
 * Post the "investigating" root message so humans know the failure is being
 * handled the moment it happens. Best-effort: when posting fails, the task
 * still launches and falls back to channel-level reporting rules.
 */
async function postInvestigationAnnouncement(params: {
  slackTarget: NonNullable<AnnouncementSlackTarget>;
  channelId: string;
  text: string;
  blocks?: SlackBlock[];
}): Promise<string | null> {
  try {
    const messageTs = await params.slackTarget.slack.postMessage({
      channel: params.channelId,
      text: params.text,
      unfurl_links: false,
      unfurl_media: false,
      blocks: params.blocks ?? [
        {
          type: 'markdown',
          text: params.text,
        },
      ],
    });

    return messageTs ?? null;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to post investigation announcement: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * An announced thread must never dangle: when the task fails to launch after
 * the opener was posted, resolve the thread with a terminal failure reply.
 */
async function postAnnouncementThreadReply(params: {
  slackTarget: NonNullable<AnnouncementSlackTarget>;
  channelId: string;
  threadTs: string;
  text: string;
}): Promise<void> {
  try {
    await params.slackTarget.slack.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      text: params.text,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: 'markdown',
          text: params.text,
        },
      ],
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to post investigation-thread reply: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Launch one environment-backed investigate-and-fix task when a workflow run
 * fails on a repository's default branch.
 */
export async function handleWorkflowRunCompleted(
  payload: WorkflowRunCompletedPayload,
): Promise<WebhookResponse> {
  const run = payload.workflow_run;

  if (run.conclusion !== 'failure') {
    return { status: 'ok', message: 'Ignoring non-failure workflow run' };
  }

  if (
    !run.head_branch ||
    run.head_branch !== payload.repository.default_branch
  ) {
    return {
      status: 'ok',
      message: 'Ignoring workflow run outside the default branch',
    };
  }

  const installationId = payload.installation?.id;

  if (!installationId) {
    return { status: 'ok', message: 'Missing installation id' };
  }

  const [match] = await db
    .select({
      repositoryId: repositories.id,
      repositoryFullName: repositories.fullName,
    })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositories.installationId),
    )
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(repositories.githubRepoId, payload.repository.id),
        eq(repositories.isActive, true),
      ),
    )
    .limit(1);

  if (!match) {
    return { status: 'ok', message: 'Repository is not active in Roomote' };
  }

  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.ciFailureTriageFrequency === 'off') {
    return { status: 'ok', message: 'CI failure triage is disabled' };
  }

  const channelId = settings.ciFailureTriageSlackChannelId;

  if (!channelId) {
    return { status: 'ok', message: 'Manager channel is not configured' };
  }

  const repositoryCoverage = await buildRepositoryCoverage([
    match.repositoryFullName,
  ]);
  const environmentId = repositoryCoverage[0]?.targetEnvironmentId;

  if (!environmentId) {
    return {
      status: 'ok',
      message: 'Repository has no configured environment for CI triage',
    };
  }

  const redis = getRedis();
  const claim = await redis.set(
    buildTriageDebounceKey(match.repositoryId),
    run.html_url,
    'EX',
    TRIAGE_DEBOUNCE_SECONDS,
    'NX',
  );

  if (claim !== 'OK') {
    return {
      status: 'ok',
      message: 'CI failure triage already debounced for this repository',
    };
  }

  const workflowName = run.name ?? payload.workflow?.name ?? 'unknown';
  const fingerprint = buildCiFailureTriageFingerprint({
    repositoryFullName: match.repositoryFullName,
    workflowName,
    headBranch: run.head_branch,
  });
  const fingerprintClaimed = await tryClaimCiFailureTriageFingerprint(
    fingerprint,
    run.html_url,
  );

  if (!fingerprintClaimed) {
    return {
      status: 'ok',
      message: 'CI failure triage fingerprint already has an active task',
    };
  }

  const announcementText = buildAnnouncementText({
    repositoryFullName: match.repositoryFullName,
    defaultBranch: payload.repository.default_branch,
    workflowName,
    runUrl: run.html_url,
    headSha: run.head_sha,
  });
  const automationLabel =
    getTriggerableBackgroundAutomationDescriptorByKey('ci_failure_triage')
      ?.label ?? 'CI Failure Triage';
  const announcementBlocks: SlackBlock[] = [
    {
      type: 'markdown',
      text: announcementText,
    },
    ...buildAutomationRootFooterBlocks({
      automationLabel,
    }),
  ];
  const slackTarget = await resolveAutomationSlackTarget({
    slackConfig: resolveScheduledSuggestionSlackConfig('ci_failure_triage'),
  });
  const announcementTs = slackTarget
    ? await postInvestigationAnnouncement({
        slackTarget,
        channelId,
        text: announcementText,
        blocks: announcementBlocks,
      })
    : null;

  if (announcementTs) {
    try {
      await upsertBackgroundAutomationSlackThread(db, {
        surface: 'slack',
        automationKey: 'ci_failure_triage',
        slackChannelId: channelId,
        threadTs: announcementTs,
        summaryText: announcementText,
        postedAt: new Date(),
        metadata: {
          triggeringRunUrl: run.html_url,
        },
      });
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to track investigation announcement thread: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: match.repositoryFullName,
            environmentId,
            selectedRepositories: [match.repositoryFullName],
            description: buildCiFailureTriagePrompt({
              channelId,
              repositoryFullNames: [match.repositoryFullName],
              repositoryCoverage,
              scanWindowStart: new Date(Date.now() - WEBHOOK_SCAN_WINDOW_MS),
              trigger: 'webhook',
              triggeringRun: {
                repositoryFullName: match.repositoryFullName,
                workflowName,
                runUrl: run.html_url,
                headBranch: run.head_branch,
                headSha: run.head_sha,
              },
              hasAnnouncementThread: announcementTs !== null,
            }),
            ...(announcementTs
              ? {
                  channel: channelId,
                  slackChannel: channelId,
                  thread_ts: announcementTs,
                  slackThreadTs: announcementTs,
                }
              : {}),
            visibleInTranscript: false,
          },
        },
        initiator: { kind: 'automation', key: 'ci_failure_triage' },
        workflow: 'standard',
        surface: 'github',
        trigger: 'webhook',
        visibility: 'hidden',
        ...(announcementTs
          ? {
              channels: {
                slackChannelId: channelId,
                slackThreadTs: announcementTs,
              },
            }
          : {}),
      },
      {
        launchClass: 'automation',
      },
    );

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'succeeded',
      at: new Date(),
    });

    if (announcementTs && slackTarget) {
      await refreshAutomationRootFooter({
        slack: slackTarget.slack,
        channelId,
        messageTs: announcementTs,
        automationLabel,
        taskUrl: getTaskUrl({
          taskId: launchResult.taskId,
          utm: { source: 'slack', campaign: 'slack.thread_reply' },
        }),
        taskId: launchResult.taskId,
      }).catch((error) => {
        console.warn(
          `${LOG_PREFIX} Failed to update investigation announcement footer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    return {
      status: 'ok',
      message: `Launched CI failure triage for ${match.repositoryFullName}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAutomationRunOutcome(db, {
      key: 'ci_failure_triage',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch((completionError: unknown) => {
      console.warn(
        `${LOG_PREFIX} Failed to record CI failure triage outcome: ${
          completionError instanceof Error
            ? completionError.message
            : String(completionError)
        }`,
      );
    });

    if (slackTarget && announcementTs) {
      await postAnnouncementThreadReply({
        slackTarget,
        channelId,
        threadTs: announcementTs,
        text: "I couldn't start the investigation for this failure. I'll pick it up on the next failing run or a manual scan from the Automations page.",
      });
    }

    console.error(
      `${LOG_PREFIX} Failed to launch CI failure triage for ${match.repositoryFullName}: ${message}`,
    );

    return { status: 'error', message };
  }
}
