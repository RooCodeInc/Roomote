import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  environments,
  eq,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  isConfiguredAutomationTarget,
  isBackgroundAutomationUserTargetKind,
  resolveEvalHarnessSelection,
  TaskPayloadKind,
  type AutomationTarget,
  type CommunicationProvider,
} from '@roomote/types';

import {
  buildDestinationPromptContext,
  buildDestinationTaskPayloadFields,
  findTeamsConversationServiceUrl,
  listConnectedCommunicationProviders,
  type ResolvedAutomationDestination,
} from './destination';
import {
  isCronRunDue,
  resolveDeploymentTimeZone,
  validateCronExpression,
  type ResolvedDeploymentTimeZone,
} from './custom-automation-schedule';
import { DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL, isRunDue } from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunNowResult,
  type AutomationRunOpts,
} from './types';
import { findUserDirectMessageDestination } from '../lib/user-direct-message';

const LOG_PREFIX = '[custom-automations]';

const PROVIDER_LABELS: Record<CommunicationProvider, string> = {
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Teams',
  telegram: 'Telegram',
};

const WINDOW_DAYS: Record<string, number> = {
  every_hour: 1 / 24,
  every_6_hours: 6 / 24,
  daily: 1,
  weekly: 7,
};

function scheduleHourLocalForFrequency(frequency: string): number {
  if (frequency === 'daily' || frequency === 'weekly') {
    return DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL;
  }

  // isRunDue always requires the local hour boundary; hour 0 means any time
  // after midnight local is eligible, so hourly windows run as soon as due.
  return 0;
}

async function resolveDestination(
  target: AutomationTarget,
): Promise<ResolvedAutomationDestination | null> {
  if (!target.provider || !target.externalRef) {
    return null;
  }

  const provider = target.provider as CommunicationProvider;
  if (
    provider !== 'slack' &&
    provider !== 'discord' &&
    provider !== 'teams' &&
    provider !== 'telegram'
  ) {
    return null;
  }

  if (isBackgroundAutomationUserTargetKind(target.targetKind)) {
    const destination = await findUserDirectMessageDestination(
      provider,
      target.externalRef,
    );
    return destination
      ? { provider, ...destination, source: 'automation_target' }
      : null;
  }

  if (provider === 'teams') {
    const metadataServiceUrl =
      typeof target.metadata?.serviceUrl === 'string'
        ? target.metadata.serviceUrl.trim()
        : '';
    const serviceUrl =
      metadataServiceUrl ||
      (await findTeamsConversationServiceUrl(target.externalRef));

    if (!serviceUrl) {
      return null;
    }

    return {
      provider,
      channelId: target.externalRef,
      source: 'automation_target',
      serviceUrl,
    };
  }

  return {
    provider,
    channelId: target.externalRef,
    source: 'automation_target',
    ...(typeof target.metadata?.serviceUrl === 'string'
      ? { serviceUrl: target.metadata.serviceUrl }
      : {}),
  };
}

function buildDefaultReportPresentationGuidance(
  hasDestination: boolean,
): string {
  const channelGuidance = hasDestination
    ? '\n- If the run completes successfully with no actionable finding, requested recurring report, durable blocker, or required user input, do not call `send_chat_reply`; finish silently so the full run remains available in the task view.\n- The first `send_chat_reply` is the report root and must stand alone. If important supporting detail would make it too long, keep the root concise and send the detail in follow-up replies in the same thread with clear headings. Keep essential conclusions and required actions in the root.'
    : '';

  return `<default_report_presentation>
These are defaults, not requirements that override the automation request above. Before applying them, check the request for explicit guidance about format, structure, length, tone, audience, or where details should appear. On any conflict, follow the request. Apply these defaults only where the request is silent.

- Lead with the result or most important takeaway in 1-2 sentences.
- Keep the primary report concise, normally no more than about 250 words.
- When the report has multiple topics, use 2-4 short bold Markdown headings with bullets underneath them.
- Keep bullets short and put one finding, decision, or action in each bullet.
- Prioritize decision-useful findings. Omit routine methodology, exhaustive test transcripts, and repeated conclusions unless the request asks for them or they materially support the result.
- When there is no report destination, keep a clean or no-action result brief and include only the most useful supporting evidence or caveats.
- Use inline links with descriptive labels instead of raw URLs when possible.${channelGuidance}
</default_report_presentation>`;
}

/**
 * Adds default presentation guidance to every custom automation prompt and,
 * when configured, anchors reporting to its destination conversation.
 *
 * A custom automation may intentionally omit a report destination. When it
 * does, prefer the admin who created/enabled it as a private fallback so an
 * enabled automation does not disappear from the communication surface.
 */
async function resolveOwnerFallbackDestination(
  ownerUserId: string | null,
): Promise<ResolvedAutomationDestination | null> {
  if (!ownerUserId) {
    return null;
  }

  const connectedProviders = await listConnectedCommunicationProviders();
  for (const provider of connectedProviders) {
    try {
      const destination = await findUserDirectMessageDestination(
        provider,
        ownerUserId,
      );
      if (destination) {
        return {
          provider,
          ...destination,
          source: 'automation_target',
        };
      }
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Failed to resolve owner DM on ${provider}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return null;
}

function buildCustomAutomationDescription(
  prompt: string,
  destination: ResolvedAutomationDestination | null,
  options: { allRepositories: boolean },
): string {
  const presentationGuidance = buildDefaultReportPresentationGuidance(
    destination !== null,
  );

  if (!destination) {
    return `${prompt}

${presentationGuidance}`;
  }

  const promptContext = buildDestinationPromptContext(destination);
  const orgWideSuggestionInstruction = options.allRepositories
    ? ' This run spans all active repositories. Every launchable suggestion must include the concrete `targetRepositoryFullName` that owns the work so Roomote can start it in the matching environment.'
    : '';

  return `${prompt}

${presentationGuidance}

<task_context>
  <source>background-automation</source>
  <${promptContext.channelTag}>${destination.channelId}</${promptContext.channelTag}>
</task_context>

This run is anchored to the ${promptContext.surfaceLabel} conversation above and reports through \`send_chat_reply\`; do not use \`${promptContext.postToolName}\` and do not post anywhere else. Stay silent while work is in flight: send no opening acknowledgement and do not post progress updates. Send a ${promptContext.surfaceLabel} message only when the final result contains an actionable finding, a report explicitly requested by the automation prompt, a durable blocker, or a required user input. If the run completes successfully without any of those outcomes, do not call \`send_chat_reply\`; finish silently so the run remains available in the task view without creating channel noise. Your first message creates this run's thread in that conversation, so make it one self-contained message that stands alone for readers who have not seen this task; later messages and user replies continue that same thread. Write the report as the result itself, like a teammate sharing what they found or did: do not mention this automation, the schedule, the task, or that anything requested the work; the message footer already attributes the automation. Lead with the outcome, not with framing like "Automation requested ..." or "Outcome: ...".${orgWideSuggestionInstruction}`;
}

async function launchCustomAutomationRow(
  automation: CustomAutomation,
  opts: AutomationRunOpts,
  scheduleContext?: ResolvedDeploymentTimeZone,
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  const frequency = getCustomAutomationFrequency(automation);

  if (automation.scheduleMode !== 'cron' && frequency === 'off') {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  if (!opts.manualTrigger) {
    const timezone = scheduleContext ?? (await resolveDeploymentTimeZone());
    const now = new Date();
    const cronBaseline = new Date(
      Math.max(
        automation.lastRunAt?.getTime() ?? automation.createdAt.getTime(),
        timezone.updatedAt?.getTime() ?? 0,
      ),
    );
    const presetLastRunAt = timezone.updatedAt
      ? new Date(
          Math.max(
            automation.lastRunAt?.getTime() ?? 0,
            timezone.updatedAt.getTime(),
          ),
        )
      : automation.lastRunAt;
    const due =
      automation.scheduleMode === 'cron'
        ? Boolean(
            automation.cronExpression &&
            isCronRunDue({
              expression: validateCronExpression(
                automation.cronExpression,
                timezone.timeZone,
              ),
              timeZone: timezone.timeZone,
              now,
              baseline: cronBaseline,
            }),
          )
        : isRunDue({
            now,
            timeZone: timezone.timeZone,
            frequency,
            lastRunAt: presetLastRunAt,
            scheduleHourLocal: scheduleHourLocalForFrequency(frequency),
            windowDays: WINDOW_DAYS,
          });

    if (!due) {
      result.skippedReason = 'Not due yet.';
      return result;
    }
  }

  if (!automation.allRepositories && !automation.environmentId) {
    result.skippedReason = 'Environment is not configured.';
    result.errors.push('Environment is not configured.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment is not configured.',
    });
    return result;
  }

  const environment = automation.allRepositories
    ? null
    : await db.query.environments.findFirst({
        columns: { id: true },
        where: eq(environments.id, automation.environmentId!),
      });

  if (!automation.allRepositories && !environment) {
    result.skippedReason = 'Environment no longer exists.';
    result.errors.push('Environment no longer exists.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment no longer exists.',
    });
    return result;
  }

  // A report destination is optional. Prefer a private DM to the admin who
  // created/enabled the automation so an enabled run still has a chat-facing
  // result; if that admin has no linked DM, preserve the task-UI fallback.
  let destination: ResolvedAutomationDestination | null = null;
  if (isConfiguredAutomationTarget(automation.target)) {
    destination = await resolveDestination(automation.target);
    if (!destination) {
      const message = isBackgroundAutomationUserTargetKind(
        automation.target.targetKind,
      )
        ? `The automation owner does not have a linked ${PROVIDER_LABELS[automation.target.provider as CommunicationProvider]} account that can receive direct messages.`
        : automation.target.provider === 'teams'
          ? 'Teams report destination is missing a resolvable service URL.'
          : 'Report destination could not be resolved.';
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }

    const connected = await listConnectedCommunicationProviders();
    if (!connected.includes(destination.provider)) {
      const message = `${destination.provider} is not connected.`;
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }
  } else {
    destination = await resolveOwnerFallbackDestination(
      automation.createdByUserId,
    );
  }

  // The short claim fence prevents concurrent launchers from double-launching
  // without blocking a due run behind a previous task that still appears active.
  const launchClaimedAt = await tryClaimCustomAutomationLaunch(
    automation.id,
    automation.lastRunAt,
  );
  if (!launchClaimedAt) {
    result.skippedReason = 'Another launch is already in progress.';
    return result;
  }

  // A persisted model override is validated on save; a value that no longer
  // parses is ignored so a stale pin degrades to the deployment default
  // instead of blocking the scheduled run.
  const modelSelection = automation.model
    ? resolveEvalHarnessSelection({ model: automation.model })
    : null;
  if (modelSelection && !modelSelection.ok) {
    console.warn(
      `${LOG_PREFIX} Ignoring invalid model override "${automation.model}" on automation ${automation.id}: ${modelSelection.error}`,
    );
  }
  const modelOverride = modelSelection?.ok ? modelSelection : null;

  try {
    const launchResult = await enqueueTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        ...(modelOverride?.harness ? { harness: modelOverride.harness } : {}),
        payload: {
          repo: automation.allRepositories ? ALL_REPOSITORIES : '',
          ...(automation.environmentId
            ? { environmentId: automation.environmentId }
            : {}),
          description: buildCustomAutomationDescription(
            automation.prompt,
            destination,
            {
              allRepositories: automation.allRepositories,
            },
          ),
          ...(destination
            ? buildDestinationTaskPayloadFields(destination)
            : {}),
          // customAutomationId authorizes the Slack late-bound thread flow:
          // the run's first send_chat_reply posts a root message in the
          // destination channel and binds it as the task thread, so later
          // updates continue the thread and user replies route back into the
          // task. The channel/slackChannel payload fields give the sandbox
          // its Slack reply context (ROOMOTE_SLACK_CHANNEL).
          ...(destination ? { customAutomationId: automation.id } : {}),
          ...(destination?.provider === 'slack'
            ? {
                channel: destination.channelId,
                slackChannel: destination.channelId,
                ...(destination.teamId
                  ? {
                      teamId: destination.teamId,
                      slackTeamId: destination.teamId,
                    }
                  : {}),
              }
            : {}),
          ...(modelOverride?.harnessModelOverrides
            ? { harnessModelOverrides: modelOverride.harnessModelOverrides }
            : {}),
        },
      },
      title: automation.name,
      initiator: {
        kind: 'automation',
        key: 'custom_automation',
        actor: {
          externalId: automation.id,
          displayName: automation.name,
        },
      },
      workflow: 'standard',
      surface: 'system',
      trigger: opts.manualTrigger ? 'manual' : 'schedule',
      ...(destination?.provider === 'slack'
        ? { channels: { slackChannelId: destination.channelId } }
        : {}),
    });

    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'succeeded',
      lastLaunchedTaskId: launchResult.taskId,
      launchClaimedAt,
    });

    result.launchedTaskId = launchResult.taskId;
    result.completed = true;
    return result;
  } catch (error) {
    await releaseCustomAutomationLaunchClaim(automation.id, launchClaimedAt);
    throw error;
  }
}

export async function customAutomationsJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting custom automations evaluator`);

  const result = emptyJobResult();
  const rows = await listEnabledCustomAutomations();

  if (rows.length === 0) {
    result.skippedReason = 'No enabled custom automations.';
    return result;
  }

  const scheduleContext = await resolveDeploymentTimeZone();
  let processed = 0;
  let skipped = 0;

  for (const automation of rows) {
    try {
      const rowResult = await launchCustomAutomationRow(
        automation,
        opts,
        scheduleContext,
      );

      if (rowResult.launchedTaskId) {
        result.launchedTaskId ??= rowResult.launchedTaskId;
        processed++;
      } else if (rowResult.errors.length > 0) {
        result.errors.push(
          ...rowResult.errors.map((e) => `${automation.name}: ${e}`),
        );
        skipped++;
      } else {
        skipped++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${automation.name}: ${message}`);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      console.error(`${LOG_PREFIX} Failed ${automation.id}: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} launched, ${skipped} skipped, ${result.errors.length} errors`,
  );

  return result;
}

export async function runCustomAutomationNow(
  id: string,
): Promise<AutomationRunNowResult> {
  const automation = await getCustomAutomationById(id);

  if (!automation) {
    return { outcome: 'failed', error: 'Custom automation was not found.' };
  }

  if (!automation.enabled) {
    return {
      outcome: 'failed',
      error:
        'This custom automation is disabled. Enable and save it before running.',
    };
  }

  try {
    const result = await launchCustomAutomationRow(automation, {
      manualTrigger: true,
    });

    if (result.launchedTaskId) {
      return { outcome: 'launched', taskId: result.launchedTaskId };
    }

    if (result.errors.length > 0) {
      return { outcome: 'failed', error: result.errors.join('; ') };
    }

    if (result.skippedReason) {
      return { outcome: 'skipped', reason: result.skippedReason };
    }

    if (result.completed) {
      return { outcome: 'completed' };
    }

    return { outcome: 'skipped', reason: 'Nothing to do.' };
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
