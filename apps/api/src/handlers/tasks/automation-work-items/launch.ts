import {
  CloudJobQueueEnqueueError,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import { CloudTaskType } from '@roomote/types';
import {
  and,
  automationWorkItems,
  db,
  eq,
  inArray,
  isNull,
  lte,
  or,
  updateBackgroundAutomationSlackThreadMetadata,
} from '@roomote/db/server';

import type { SlackNotifier } from '@roomote/slack';

import { apiLogger } from '../../../logging.js';
import { postLateBoundWorkItemFailureMessage } from './slack.js';
import { postLateBoundWorkItemFailureToTelegram } from './telegram.js';
import { postLateBoundWorkItemFailureToTeams } from './teams.js';
import type { PersistedAutomationWorkItem } from './types.js';

const LAUNCH_CLAIM_STALE_MS = 10 * 60 * 1000;
const LAUNCHABLE_ACT_STATUSES = ['open', 'acting'] as const;

type AutomationExecutionTaskBootstrap =
  | '$implement-changes'
  | '$update-dependencies';

const DEFAULT_AUTOMATION_EXECUTION_INSTRUCTIONS =
  'Treat this as an automation-started execution task. Do the work directly, keep progress visible in the web task, and deliver the result through the normal task PR flow without posting status updates back to Slack.';

function buildLateBoundChatReplyInstructions(
  hasThread: boolean,
  surface: 'Slack' | 'Telegram' | 'Teams',
): string {
  return [
    'Treat this as an automation-started execution task.',
    'Do the work directly and stay silent while work is in flight.',
    `Do not send ${surface} progress updates, elapsed-time updates, validation-started updates, or partial findings.`,
    'Keep intermediate status in the web task and todo list only.',
    `For this initial channel-only launch, do not send a ${surface}-visible opening acknowledgement; wait until you have a final result, blocker, or required input before the first send_chat_reply.`,
    `Post to ${surface} only when you have a final successful result (for example, a shipped change or an opened draft PR), a final no-op/deferred result after reverting untrusted changes, a durable blocker that stops the run, or a concrete user input request that is required before you can continue.`,
    'Do not post a launch announcement.',
    hasThread
      ? `Reply in the existing ${surface} investigation thread, but still assume readers do not know about the hidden research task or spawned environment task behind this run.`
      : `Your first ${surface}-visible message may create a new top-level thread, so make it fully standalone and do not assume readers have seen any earlier scan, audit, or research task.`,
    `Keep the first ${surface}-visible closeout as one self-contained message instead of a separate opener plus a result.`,
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
    'For blocker, no-op, deferred, or input-needed outcomes, keep the same single-message shape but report only the outcome-relevant details and do not invent remediation or verification sections.',
    'For example, a Dependabot closeout should read like: "I reviewed [alert #275](...) and opened [draft PR #4783](...) to address a high and two medium `undici` vulnerabilities in the API dependency bundle."',
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
    chatSurface: 'Slack' | 'Telegram' | 'Teams';
  },
): string {
  const lines = [
    options.executionTaskBootstrap,
    '',
    `Automation work item: ${item.title}`,
    item.brief,
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
      ? `Investigation context:\n${item.investigationContext}`
      : null,
    item.executionPrompt ? `Execution prompt:\n${item.executionPrompt}` : null,
  ];

  return lines.filter(Boolean).join('\n');
}

async function postLateBoundWorkItemFailureToChatTarget(params: {
  chatTarget: AutomationChatTarget;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
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
    };

export async function launchActWorkItems(params: {
  userId: string | null;
  workItems: PersistedAutomationWorkItem[];
  executionTaskBootstrap: AutomationExecutionTaskBootstrap;
  chatTarget: AutomationChatTarget | null;
}): Promise<{ launchedCount: number; failedCount: number }> {
  let launchedCount = 0;
  let failedCount = 0;

  for (const workItem of params.workItems) {
    const claimStaleBefore = new Date(Date.now() - LAUNCH_CLAIM_STALE_MS);

    const [claimedWorkItem] = await db
      .update(automationWorkItems)
      .set({
        status: 'acting',
        launchClaimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationWorkItems.id, workItem.id),
          isNull(automationWorkItems.executionTaskId),
          inArray(automationWorkItems.status, [...LAUNCHABLE_ACT_STATUSES]),
          or(
            isNull(automationWorkItems.launchClaimedAt),
            lte(automationWorkItems.launchClaimedAt, claimStaleBefore),
          ),
        ),
      )
      .returning({ id: automationWorkItems.id });

    if (!claimedWorkItem) {
      continue;
    }

    let linkedTaskId: string | null = null;

    try {
      if (!workItem.targetRepositoryFullName) {
        throw new Error(
          `Work item "${workItem.title}" must include targetRepositoryFullName when disposition is act.`,
        );
      }

      const markWorkItemStarted = async (taskId: string | null) => {
        const [startedWorkItem] = await db
          .update(automationWorkItems)
          .set({
            status: 'started',
            executionTaskId: taskId,
            launchedAt: new Date(),
            launchClaimedAt: null,
            launchError: null,
            updatedAt: new Date(),
          })
          .where(and(eq(automationWorkItems.id, workItem.id)))
          .returning({ id: automationWorkItems.id });

        if (!startedWorkItem) {
          throw new Error(
            `Failed to persist launch tracking for work item ${workItem.id}.`,
          );
        }

        linkedTaskId = taskId;
      };

      await enqueueCloudTask(
        {
          userId: params.userId,
          type: CloudTaskType.StandardTask,
          payload: {
            repo: workItem.targetRepositoryFullName,
            ...(workItem.targetEnvironmentId
              ? { environmentId: workItem.targetEnvironmentId }
              : {}),
            selectedRepositories: [workItem.targetRepositoryFullName],
            description: buildExecutionTaskPrompt(workItem, {
              executionTaskBootstrap: params.executionTaskBootstrap,
              lateBoundChatReplies: params.chatTarget !== null,
              hasChatThread:
                params.chatTarget?.provider === 'slack' &&
                Boolean(params.chatTarget.threadTs),
              chatSurface:
                params.chatTarget?.provider === 'telegram'
                  ? 'Telegram'
                  : params.chatTarget?.provider === 'teams'
                    ? 'Teams'
                    : 'Slack',
            }),
            ...(params.chatTarget?.provider === 'slack'
              ? {
                  automationWorkItemId: workItem.id,
                  channel: params.chatTarget.channelId,
                  slackChannel: params.chatTarget.channelId,
                  ...(params.chatTarget.threadTs
                    ? {
                        thread_ts: params.chatTarget.threadTs,
                        slackThreadTs: params.chatTarget.threadTs,
                      }
                    : {}),
                }
              : {}),
            ...(params.chatTarget?.provider === 'telegram'
              ? {
                  automationWorkItemId: workItem.id,
                  communicationProvider: 'telegram',
                  communicationChannelId: params.chatTarget.chatId,
                }
              : {}),
            ...(params.chatTarget?.provider === 'teams'
              ? {
                  automationWorkItemId: workItem.id,
                  communicationProvider: 'teams',
                  communicationChannelId: params.chatTarget.conversationId,
                  communicationServiceUrl: params.chatTarget.serviceUrl,
                }
              : {}),
            visibleInTranscript: false,
          },
        },
        {
          launchClass: 'automation',
          beforeEnqueue: (cloudJob) => markWorkItemStarted(cloudJob.taskId),
        },
      );

      if (
        params.chatTarget?.provider === 'slack' &&
        params.chatTarget.threadTs &&
        linkedTaskId
      ) {
        await updateBackgroundAutomationSlackThreadMetadata(db, {
          slackChannelId: params.chatTarget.channelId,
          threadTs: params.chatTarget.threadTs,
          metadata: {
            sourceTaskId: linkedTaskId,
          },
        });
      }
    } catch (error) {
      failedCount += 1;
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to auto-start work item';
      const shouldRetry =
        error instanceof CloudJobQueueEnqueueError && linkedTaskId !== null;

      await db
        .update(automationWorkItems)
        .set(
          shouldRetry
            ? {
                status: 'open',
                executionTaskId: null,
                launchedAt: null,
                failedAt: null,
                launchClaimedAt: null,
                launchError: message,
                updatedAt: new Date(),
              }
            : {
                status: 'failed',
                failedAt: new Date(),
                launchClaimedAt: null,
                launchError: message,
                updatedAt: new Date(),
              },
        )
        .where(eq(automationWorkItems.id, workItem.id));

      if (params.chatTarget && !shouldRetry) {
        // Late-bound launches have no execution task to report through, so a
        // terminal launch failure must surface here or it disappears entirely.
        await postLateBoundWorkItemFailureToChatTarget({
          chatTarget: params.chatTarget,
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
