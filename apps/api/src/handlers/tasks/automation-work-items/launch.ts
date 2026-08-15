import {
  TaskRunQueueEnqueueError,
  buildAutomationExecutionGuidanceBlock,
  buildUntrustedContentPolicy,
  buildUntrustedExternalContentBlock,
  enqueueTask,
  escapeTaskContextText,
} from '@roomote/cloud-agents/server';
import { finalizeAutomationLaunch } from '@roomote/sdk/server/automation-post-launch-finalization';
import { TaskPayloadKind, type BackgroundAutomationKey } from '@roomote/types';
import {
  and,
  claimWorkItem,
  db,
  eq,
  finalizeWorkItemLaunched,
  workItems,
} from '@roomote/db/server';

import type { SlackNotifier } from '@roomote/slack';

import { apiLogger } from '../../../logging.js';
import { postLateBoundWorkItemFailureMessage } from './slack.js';
import { postLateBoundWorkItemFailureToTelegram } from './telegram.js';
import { postLateBoundWorkItemFailureToTeams } from './teams.js';
import {
  createAutomationDiscordTaskThread,
  DiscordAutomationTargetPreparationError,
  postLateBoundWorkItemFailureToDiscord,
  type AutomationDiscordTarget,
} from './discord.js';
import type { PersistedAutomationWorkItem } from './types.js';

type AutomationExecutionTaskBootstrap =
  | '$implement-changes'
  | '$update-dependencies';

const DEFAULT_AUTOMATION_EXECUTION_INSTRUCTIONS =
  'Treat this as an automation-started execution task. Do the work directly, keep progress visible in the web task, and deliver the result through the normal task PR flow without posting status updates back to Slack.';

function buildLateBoundChatReplyInstructions(
  hasThread: boolean,
  surface: 'Slack' | 'Telegram' | 'Teams' | 'Discord',
): string {
  return [
    'Treat this as an automation-started execution task.',
    'Do the work directly and stay silent while work is in flight.',
    `Do not send ${surface} progress updates, elapsed-time updates, validation-started updates, or partial findings.`,
    'Keep intermediate status in the web task and todo list only.',
    `For this initial channel-only launch, do not send a ${surface}-visible opening acknowledgement.`,
    `Default to finishing silently. Post to ${surface} only when there is something a human should see now: a meaningful completed result (for example, a shipped change or an opened draft PR), an actionable or important finding, a durable blocker that stops the run, or a concrete user input request that is required before you can continue. Routine success, no-change results, and no-op or deferred outcomes that require no human action should not produce a message.`,
    'Do not post a launch announcement.',
    hasThread
      ? `Reply in the existing ${surface} investigation thread, but still assume readers do not know about the hidden research task or spawned environment task behind this run.`
      : `Your first ${surface}-visible message may create a new top-level thread, so make it fully standalone and do not assume readers have seen any earlier scan, audit, or research task.`,
    `If you report, keep the first ${surface}-visible closeout as one self-contained message instead of a separate opener plus a result.`,
    'Write that closeout like a helpful coworker summarizing completed work, not like a system relay or callback from another hidden task.',
    'Do not frame the message as a follow-up on a hidden scan, audit, evaluator, research task, or spawned environment task.',
    `Pretend the ${surface} reader only sees that one closeout message and none of the hidden automation or environment context behind it.`,
    'Lead with a direct plain-language sentence that names the object of the work, says what you reviewed, why it mattered, and what changed or how far it got. On first mention, spell out the object before shorthand or identifiers: say "the Sentry issues [ROOMOTE-WORKER-381](...) and [ROOMOTE-WORKER-382](...)", "Dependabot alert #275", "pull request #4707", or "the failing worker environment setup task", not just bare IDs or labels. Prefer result-first wording like "I reviewed [alert #275](...) and opened [draft PR #4783](...) to address ..." or "I reviewed the Sentry issue SENTRY-123 and opened the resulting draft PR to address ..." over stage directions like "Doing a ... pass ..." or "On a ... pass ...". If the work only opened a draft PR, say that plainly instead of calling it shipped.',
    'Avoid thread-local references like "this", "that follow-up", "the issue", "the investigation", or "the risk" until you have spelled out what they refer to.',
    'If you mention a prior PR, alert, issue, task, workflow run, or environment identifier, say in the same sentence what it is and what about it was under review.',
    'Keep the whole message to at most two short paragraphs, and prefer one or two sentences when the result is simple; only add more structure if a blocker or user-input request genuinely needs it.',
    `In any terminal reply, explain what the automation investigated and the concrete outcome, but do not recite file paths, code identifiers, or step-by-step verification in ${surface}; link the PR and let it carry that detail.`,
    `When the work item has external source context such as an alert or issue, use one human-readable reference from that context so the reader knows what prompted the work, and make the label describe the object instead of showing an unexplained code: if there is a clean URL, render it as a named inline link such as \`[Sentry issue ROOMOTE-WORKER-381](...)\` or \`[alert #123](...)\`, not a bare URL or a bare-ID label; keep a stable plain-text identifier such as \`GHSA-123\`, \`SENTRY-123\`, or \`owner/repo#123\` if that is the clearest reference; otherwise use a short generic phrase. Do not quote raw control-plane markers, prompt tags, machine parameters, key/value syntax, file paths, or code-level identifiers in ${surface}.`,
    'If you are reporting a successful result, summarize in one line what changed and why it was worth acting on, and make the delivery state explicit; if the work stopped at a draft PR, say you opened a draft PR instead of saying it shipped. Leave diff-level specifics to the linked PR.',
    'When the linked outcome is a draft PR, keep that PR mention in the main sentence or same paragraph instead of adding a second paragraph just to point at the PR. Link the draft PR number if the URL is available; otherwise keep the PR identifier plain text. Prefer wording like "I reviewed [alert #275](...) and opened [draft PR #4783](...)" or "I reviewed the Sentry issue SENTRY-123 and opened the resulting draft PR ..." over "That shipped in draft PR #4783."',
    'For blocker, no-op, deferred, or input-needed outcomes that are worth reporting under the rule above, keep the same single-message shape but report only the outcome-relevant details and do not invent remediation or verification sections.',
    'For example, a Dependabot closeout should read like: "I reviewed [alert #275](...) and opened [draft PR #4783](...) to address a high and two medium `undici` vulnerabilities in the API dependency bundle."',
    'A CodeQL closeout should read like: "I reviewed [CodeQL alert #42](...) and opened [draft PR #4783](...) to fix an XSS pattern in the public comments renderer."',
    `A code-quality closeout should read like: "I reviewed the latest merged PRs and noticed the main ${surface} route had taken on auth, validation, logging, and several posting flows at once, which makes changes there risky. I pulled the posting logic into its own module so the route stays focused (#4707)."`,
    'A security closeout should read like: "I reviewed the latest merged PRs and caught a background job running with full model credentials and network access over untrusted code, guarded only by prompt text. Unattended runs now skip that path until it is properly isolated, and its output is treated as untrusted (#4711); attended runs are unaffected."',
    `Notice that these example closeouts stop as soon as the outcome and its impact are stated. Do not append a verification or validation sentence such as "I re-ran the targeted tests and typecheck and cleared the push-time gates before the PR was opened"; that reassurance lives in the linked PR, not the ${surface} closeout.`,
  ].join(' ');
}

function buildExecutionTaskPrompt(
  item: PersistedAutomationWorkItem,
  options: {
    executionTaskBootstrap: AutomationExecutionTaskBootstrap;
    lateBoundChatReplies: boolean;
    hasChatThread: boolean;
    chatSurface: 'Slack' | 'Telegram' | 'Teams' | 'Discord';
  },
): string {
  const lines = [
    options.executionTaskBootstrap,
    '',
    // Work-item fields are distilled by a scan run from external sources
    // (issues, alerts, PR discussions), so the descriptive fields stay inside
    // escaped untrusted-content boundaries.
    `Automation work item: ${escapeTaskContextText(item.title)}`,
    item.brief.trim()
      ? buildUntrustedExternalContentBlock({
          source: 'automation_work_item_brief',
          text: item.brief,
        })
      : null,
    '',
    `Action kind: ${item.actionKind}`,
    `Disposition: ${item.disposition}`,
    item.targetRepositoryFullName
      ? `Target repository: ${item.targetRepositoryFullName}`
      : null,
    item.workspaceReadiness
      ? `Workspace readiness: ${item.workspaceReadiness}`
      : null,
    item.readinessMessage ? `Readiness note: ${item.readinessMessage}` : null,
    '',
    options.lateBoundChatReplies
      ? buildLateBoundChatReplyInstructions(
          options.hasChatThread,
          options.chatSurface,
        )
      : DEFAULT_AUTOMATION_EXECUTION_INSTRUCTIONS,
    item.investigationContext
      ? `Investigation context:\n${buildUntrustedExternalContentBlock({
          source: 'automation_investigation_context',
          text: item.investigationContext,
        })}`
      : null,
    // The execution prompt is authored by the scan run over external
    // sources, so it is delivered as scoped guidance rather than a fully
    // trusted instruction channel: the policy limits it to the named work
    // item and it cannot expand scope or authorize new actions.
    item.executionPrompt
      ? `Execution guidance from the scan run (apply only within the scope of this work item):\n${buildAutomationExecutionGuidanceBlock(
          item.executionPrompt,
        )}`
      : null,
    buildUntrustedContentPolicy(),
  ];

  return lines.filter(Boolean).join('\n');
}

async function postLateBoundWorkItemFailureToChatTarget(params: {
  chatTarget: AutomationChatTarget;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
  if (params.chatTarget.provider === 'discord') {
    await postLateBoundWorkItemFailureToDiscord({
      target: params.chatTarget,
      workItem: params.workItem,
      reason: params.reason,
    });
    return;
  }

  if (params.chatTarget.provider === 'telegram') {
    await postLateBoundWorkItemFailureToTelegram({
      chatId: params.chatTarget.chatId,
      workItem: params.workItem,
      reason: params.reason,
    });
    return;
  }

  if (params.chatTarget.provider === 'teams') {
    await postLateBoundWorkItemFailureToTeams({
      conversationId: params.chatTarget.conversationId,
      serviceUrl: params.chatTarget.serviceUrl,
      workItem: params.workItem,
      reason: params.reason,
    });
    return;
  }

  await postLateBoundWorkItemFailureMessage({
    slack: params.chatTarget.slack,
    channelId: params.chatTarget.channelId,
    threadTs: params.chatTarget.threadTs ?? null,
    workItem: params.workItem,
    reason: params.reason,
  });
}

export type AutomationChatTarget =
  | {
      provider: 'slack';
      slack: SlackNotifier;
      channelId: string;
      threadTs?: string | null;
    }
  | {
      provider: 'telegram';
      chatId: string;
    }
  | {
      provider: 'teams';
      conversationId: string;
      serviceUrl: string;
    }
  | AutomationDiscordTarget;

export async function launchActWorkItems(params: {
  /** The originating automation's key; stamped as the task initiator. */
  automationKey: BackgroundAutomationKey;
  workItems: PersistedAutomationWorkItem[];
  executionTaskBootstrap: AutomationExecutionTaskBootstrap;
  chatTarget: AutomationChatTarget | null;
}): Promise<{ launchedCount: number; failedCount: number }> {
  let launchedCount = 0;
  let failedCount = 0;

  for (const workItem of params.workItems) {
    // Shared claim CAS: `open`/stale-`launching` with launched_task_id null.
    // `failed` stays terminal by design (never in the claimable set).
    const claimedWorkItem = await claimWorkItem(db, { id: workItem.id });

    if (!claimedWorkItem) {
      continue;
    }

    let linkedTaskId: string | null = null;
    let workItemChatTarget = params.chatTarget;

    try {
      if (!workItem.targetRepositoryFullName) {
        throw new Error(
          `Work item "${workItem.title}" must include targetRepositoryFullName when disposition is act.`,
        );
      }

      const markWorkItemStarted = async (taskId: string | null) => {
        const startedWorkItem = await finalizeWorkItemLaunched(db, {
          id: workItem.id,
          taskId,
          claimedAt: claimedWorkItem.launchClaimedAt,
          clearLaunchError: true,
        });

        if (!startedWorkItem) {
          throw new Error(
            `Failed to persist launch tracking for work item ${workItem.id}.`,
          );
        }

        linkedTaskId = taskId;
      };

      if (workItemChatTarget?.provider === 'discord') {
        workItemChatTarget = await createAutomationDiscordTaskThread({
          target: workItemChatTarget,
          workItem,
        });
      }

      await enqueueTask(
        {
          task: {
            type: TaskPayloadKind.StandardTask,
            payload: {
              repo: workItem.targetRepositoryFullName,
              ...(workItem.targetEnvironmentId
                ? { environmentId: workItem.targetEnvironmentId }
                : {}),
              selectedRepositories: [workItem.targetRepositoryFullName],
              description: buildExecutionTaskPrompt(workItem, {
                executionTaskBootstrap: params.executionTaskBootstrap,
                lateBoundChatReplies: workItemChatTarget !== null,
                hasChatThread:
                  (workItemChatTarget?.provider === 'slack' &&
                    Boolean(workItemChatTarget.threadTs)) ||
                  (workItemChatTarget?.provider === 'discord' &&
                    Boolean(workItemChatTarget.threadId)),
                chatSurface:
                  workItemChatTarget?.provider === 'telegram'
                    ? 'Telegram'
                    : workItemChatTarget?.provider === 'teams'
                      ? 'Teams'
                      : workItemChatTarget?.provider === 'discord'
                        ? 'Discord'
                        : 'Slack',
              }),
              ...(workItemChatTarget?.provider === 'slack'
                ? {
                    automationWorkItemId: workItem.id,
                    channel: workItemChatTarget.channelId,
                    slackChannel: workItemChatTarget.channelId,
                    ...(workItemChatTarget.threadTs
                      ? {
                          thread_ts: workItemChatTarget.threadTs,
                          slackThreadTs: workItemChatTarget.threadTs,
                        }
                      : {}),
                  }
                : {}),
              ...(workItemChatTarget?.provider === 'telegram'
                ? {
                    automationWorkItemId: workItem.id,
                    communicationProvider: 'telegram',
                    communicationChannelId: workItemChatTarget.chatId,
                  }
                : {}),
              ...(workItemChatTarget?.provider === 'teams'
                ? {
                    automationWorkItemId: workItem.id,
                    communicationProvider: 'teams',
                    communicationChannelId: workItemChatTarget.conversationId,
                    communicationServiceUrl: workItemChatTarget.serviceUrl,
                  }
                : {}),
              ...(workItemChatTarget?.provider === 'discord'
                ? {
                    automationWorkItemId: workItem.id,
                    communicationProvider: 'discord',
                    communicationGuildId: workItemChatTarget.guildId,
                    communicationChannelId: workItemChatTarget.channelId,
                    ...(workItemChatTarget.threadId
                      ? { communicationThreadId: workItemChatTarget.threadId }
                      : {}),
                    ...(workItemChatTarget.messageId
                      ? {
                          communicationMessageId: workItemChatTarget.messageId,
                        }
                      : {}),
                    discordTaskThread: Boolean(workItemChatTarget.threadId),
                  }
                : {}),
              visibleInTranscript: false,
            },
          },
          initiator: { kind: 'automation', key: params.automationKey },
          workflow: 'standard',
          surface:
            workItemChatTarget?.provider === 'discord' ? 'discord' : 'system',
          trigger: 'schedule',
          ...(workItemChatTarget?.provider === 'slack'
            ? {
                channels: {
                  slackChannelId: workItemChatTarget.channelId,
                  slackThreadTs: workItemChatTarget.threadTs ?? null,
                },
              }
            : {}),
        },
        {
          launchClass: 'automation',
          beforeEnqueue: (taskRun) => markWorkItemStarted(taskRun.taskId),
        },
      );

      if (workItemChatTarget && linkedTaskId) {
        await finalizeAutomationLaunch({
          conversation: {
            provider: workItemChatTarget.provider,
            channelId:
              workItemChatTarget.provider === 'telegram'
                ? workItemChatTarget.chatId
                : workItemChatTarget.provider === 'teams'
                  ? workItemChatTarget.conversationId
                  : workItemChatTarget.channelId,
            rootMessageId:
              workItemChatTarget.provider === 'slack'
                ? workItemChatTarget.threadTs
                : workItemChatTarget.provider === 'discord'
                  ? workItemChatTarget.messageId
                  : undefined,
          },
          taskId: linkedTaskId,
          context: '[submitAutomationWorkItems]',
          warn: apiLogger.warn.bind(apiLogger),
        });
      }
    } catch (error) {
      failedCount += 1;
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to auto-start work item';
      const retryLaunchedTaskId =
        error instanceof TaskRunQueueEnqueueError ? linkedTaskId : null;
      const shouldRetry = retryLaunchedTaskId !== null;
      // A transient chat-target failure happens before finalize, so the row
      // is still `launching` under our claim; reopen it instead of terminally
      // failing — the persisted thread coordinate lets the retry resume in
      // the same conversation.
      const shouldReopenUnderClaim =
        error instanceof DiscordAutomationTargetPreparationError;

      // All failure writes are fenced so a stale launcher whose claim was
      // reclaimed can never fail or clear the fresh claimant's row:
      // - retry (finalize succeeded, queue publish failed): the row is OUR
      //   `launched` row, so guard on status='launched' + our task link.
      // - reopen (transient failure before finalize): the row must still be
      //   `launching` under OUR claim token.
      // - terminal failure: same `launching`-under-our-claim guard; after a
      //   reclaim this is a no-op.
      const [failureWriteApplied] = shouldRetry
        ? await db
            .update(workItems)
            .set({
              status: 'open',
              launchedTaskId: null,
              launchedAt: null,
              failedAt: null,
              launchClaimedAt: null,
              launchError: message,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(workItems.id, workItem.id),
                eq(workItems.status, 'launched'),
                eq(workItems.launchedTaskId, retryLaunchedTaskId),
              ),
            )
            .returning({ id: workItems.id })
        : shouldReopenUnderClaim
          ? await db
              .update(workItems)
              .set({
                status: 'open',
                failedAt: null,
                launchClaimedAt: null,
                launchError: message,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(workItems.id, workItem.id),
                  eq(workItems.status, 'launching'),
                  eq(
                    workItems.launchClaimedAt,
                    claimedWorkItem.launchClaimedAt,
                  ),
                ),
              )
              .returning({ id: workItems.id })
          : await db
              .update(workItems)
              .set({
                status: 'failed',
                failedAt: new Date(),
                launchClaimedAt: null,
                launchError: message,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(workItems.id, workItem.id),
                  eq(workItems.status, 'launching'),
                  eq(
                    workItems.launchClaimedAt,
                    claimedWorkItem.launchClaimedAt,
                  ),
                ),
              )
              .returning({ id: workItems.id });

      if (!failureWriteApplied) {
        apiLogger.warn(
          `[submitAutomationWorkItems] fenced failure write for work item ${workItem.id} did not apply (claim reclaimed or state moved on); leaving the current claimant's row untouched`,
        );
      }

      if (workItemChatTarget && !shouldRetry && !shouldReopenUnderClaim) {
        // Late-bound launches have no execution task to report through, so a
        // terminal launch failure must surface here or it disappears entirely.
        await postLateBoundWorkItemFailureToChatTarget({
          chatTarget: workItemChatTarget,
          workItem,
          reason: message,
        }).catch((postError) => {
          apiLogger.warn(
            `[submitAutomationWorkItems] Failed to post late-bound launch failure for work item ${workItem.id}: ${
              postError instanceof Error ? postError.message : String(postError)
            }`,
          );
        });
      }

      continue;
    }

    launchedCount += 1;
  }

  return { launchedCount, failedCount };
}
