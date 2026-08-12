import {
  TASK_TURN_PROVIDER_ERROR_TEXT,
  formatMarkdownLink,
} from '@roomote/communication/chat-messages';
import {
  type AcpPersistedEnvelope,
  asRecord,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getTerminalProviderErrorFromMessageData,
} from '@roomote/types';
import {
  type Task,
  type TaskRun,
  db,
  and,
  eq,
  slackInstallations,
  taskRuns,
} from '@roomote/db/server';
import { getTaskUrl } from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';
import { SlackNotifier } from '@roomote/slack';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from '../discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '../teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from '../telegram-communication';
import {
  escapeSlackMrkdwnText,
  formatChannelProviderError,
} from './channel-provider-error-text';
import { resolveSlackTaskRunRouting } from './slack-task-run-routing';

const TURN_PROVIDER_ERROR_CLAIM_KEY_PREFIX = 'turn-provider-error:';
const TURN_PROVIDER_ERROR_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

type NotifiedRun = TaskRun & { task: Task };

/**
 * Read the terminal provider error off a persisted envelope. The harness stamps
 * it into both `metadata` and `payload`; either is authoritative.
 */
function getEnvelopeTerminalProviderError(
  envelope: AcpPersistedEnvelope,
): string | null {
  const fromMetadata = getTerminalProviderErrorFromMessageData(
    asRecord(envelope.metadata),
  );

  if (fromMetadata) {
    return fromMetadata.errorSummary;
  }

  return (
    getTerminalProviderErrorFromMessageData(asRecord(envelope.payload))
      ?.errorSummary ?? null
  );
}

function getClaimKey(input: { runId: number; ts: number }): string {
  return `${TURN_PROVIDER_ERROR_CLAIM_KEY_PREFIX}${input.runId}:${input.ts}`;
}

/**
 * Best-effort duplicate suppression keyed by run + envelope timestamp. Envelope
 * persistence is retried and upserted, so without this a single failed turn
 * could announce itself in the thread several times.
 *
 * This is deliberately not strict at-most-once delivery: no chat API offers
 * that, since a post can succeed while its response is lost. In that ambiguous
 * window the claim is released and a retry may post twice. A duplicate notice
 * is the better failure direction than a silent thread.
 */
async function claimTurnProviderErrorNotification(input: {
  runId: number;
  ts: number;
}): Promise<boolean> {
  const claim = await getRedis().set(
    getClaimKey(input),
    '1',
    'EX',
    TURN_PROVIDER_ERROR_CLAIM_TTL_SECONDS,
    'NX',
  );

  return claim === 'OK';
}

/**
 * Hand the claim back when nothing was actually delivered, so a later retry of
 * the same envelope can try again instead of inheriting a claim that only ever
 * produced silence.
 */
async function releaseTurnProviderErrorNotification(input: {
  runId: number;
  ts: number;
}): Promise<void> {
  await getRedis().del(getClaimKey(input));
}

function buildMarkdownNotificationText(
  run: NotifiedRun,
  error: string,
  source: string,
): string {
  const taskUrl = getTaskUrl({
    taskId: run.taskId,
    utm: { campaign: run.payloadKind, source },
  });

  return [
    TASK_TURN_PROVIDER_ERROR_TEXT,
    `**Error details:** ${error}`,
    taskUrl ? formatMarkdownLink('Open the task', taskUrl) : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

async function notifyTeams(run: NotifiedRun, error: string): Promise<boolean> {
  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    console.warn(
      `[turnProviderError] Teams bot credentials are not configured, skipping notification for run ${run.id}`,
    );
    return false;
  }

  const channelId = getCommunicationChannelFromTaskPayload(run.payload);
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(run.payload);

  if (!channelId || !serviceUrl) {
    console.warn(
      `[turnProviderError] Missing Teams conversation metadata for run ${run.id}, skipping notification`,
    );
    return false;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(run.payload);
  const messageId = getCommunicationMessageIdFromTaskPayload(run.payload);
  const replyToMessageId = threadId ?? messageId;

  await provider.postMessage({
    channelId,
    serviceUrl,
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    text: buildMarkdownNotificationText(run, error, 'teams'),
    textFormat: 'markdown',
  });

  return true;
}

/**
 * Discord and Telegram share thread coordinates and markdown delivery: reply in
 * the task's thread/topic when there is one, otherwise reply to the message that
 * opened the task.
 */
async function notifyThreadedMarkdownProvider(
  run: NotifiedRun,
  error: string,
  provider: 'discord' | 'telegram',
): Promise<boolean> {
  const adapter =
    provider === 'discord'
      ? await createDiscordCommunicationProviderFromRuntimeCredentials()
      : await createTelegramCommunicationProviderFromRuntimeCredentials();

  if (!adapter) {
    console.warn(
      `[turnProviderError] ${provider} bot credentials are not configured, skipping notification for run ${run.id}`,
    );
    return false;
  }

  const channelId = getCommunicationChannelFromTaskPayload(run.payload);

  if (!channelId) {
    console.warn(
      `[turnProviderError] Missing ${provider} channel metadata for run ${run.id}, skipping notification`,
    );
    return false;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(run.payload);
  const messageId = getCommunicationMessageIdFromTaskPayload(run.payload);

  await adapter.postMessage({
    channelId,
    ...(threadId ? { threadId } : {}),
    ...(!threadId && messageId ? { replyToMessageId: messageId } : {}),
    text: buildMarkdownNotificationText(run, error, provider),
    textFormat: 'markdown',
  });

  return true;
}

/**
 * Reply in the originating Slack thread. Unlike the terminal-failure path this
 * never touches the started message or its Cancel button: the task is still
 * live and resumable, so its controls must stay usable.
 */
async function notifySlack(run: NotifiedRun, error: string): Promise<boolean> {
  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(eq(slackInstallations.isActive, true)),
  });

  if (!slackInstallation) {
    console.warn(
      `[turnProviderError] No active Slack installation, skipping notification for run ${run.id}`,
    );
    return false;
  }

  const { channel, threadTs } = await resolveSlackTaskRunRouting(run);

  if (!channel) {
    console.warn(
      `[turnProviderError] No Slack channel found for run ${run.id}, skipping notification`,
    );
    return false;
  }

  const taskUrl = getTaskUrl({
    taskId: run.taskId,
    utm: { campaign: run.payloadKind, source: 'slack' },
  });
  const text = [
    TASK_TURN_PROVIDER_ERROR_TEXT,
    `*Error details:* ${escapeSlackMrkdwnText(error)}`,
    taskUrl ? `<${taskUrl}|Open the task>` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');

  // `SlackNotifier.postMessage` logs and returns no timestamp on API or
  // transport failure instead of throwing, so the returned ts is the only
  // signal that the reply actually landed.
  const messageTs = await new SlackNotifier(
    slackInstallation.botAccessToken,
  ).postMessage({
    channel,
    thread_ts: threadTs ?? run.task.slackThreadTs ?? undefined,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!messageTs) {
    console.warn(
      `[turnProviderError] Slack rejected the provider-error reply for run ${run.id}`,
    );
    return false;
  }

  return true;
}

/**
 * Report a turn-ending provider error into the conversation that started the
 * task, on whichever chat platform that was.
 *
 * A terminal provider error kills the model turn but deliberately leaves the
 * task session alive for follow-ups, so the run settles as `idle` rather than
 * `failed` and never reaches the terminal-failure notifications in `finishRun`.
 * The agent cannot report it either -- its turn is already dead, so it never
 * gets to call `send_chat_reply`. Without this the thread just goes quiet.
 *
 * Delivery is therefore driven by the error message itself and is independent of
 * run status: the task may stay alive, sleep, or resume later and the thread
 * still gets told. Never throws.
 */
async function notifySourceThreadOfTerminalProviderError(input: {
  runId: number;
  taskId: string;
  ts: number;
  errorSummary: string;
}): Promise<void> {
  const error = formatChannelProviderError(input.errorSummary);

  if (!error) {
    // Unrecognized or unsafe-to-echo error text. The full detail stays in the
    // task transcript rather than being pasted into a customer channel.
    return;
  }

  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    with: { task: true },
  });

  if (!run || run.taskId !== input.taskId) {
    return;
  }

  const provider = run.task.slackThreadTs
    ? 'slack'
    : getCommunicationProviderFromTaskPayload(run.payload);

  if (!provider) {
    // Task was not started from a chat surface (web, GitHub, Linear, ...), so
    // there is no source thread to report into.
    return;
  }

  // Claim before delivering so concurrent envelope writes cannot both post,
  // then hand the claim back below if nothing actually went out.
  if (!(await claimTurnProviderErrorNotification(input))) {
    return;
  }

  let delivered = false;

  try {
    switch (provider) {
      case 'slack':
        delivered = await notifySlack(run, error);
        break;
      case 'teams':
        delivered = await notifyTeams(run, error);
        break;
      case 'discord':
      case 'telegram':
        delivered = await notifyThreadedMarkdownProvider(run, error, provider);
        break;
    }
  } finally {
    if (!delivered) {
      // Missing credentials, unusable routing, a rejected post, or a thrown
      // adapter error all mean the thread is still silent. Release the claim so
      // a later retry of this same envelope can report it instead of inheriting
      // a claim that only ever produced silence.
      await releaseTurnProviderErrorNotification(input).catch(
        (releaseError: unknown) => {
          console.warn(
            `[turnProviderError] Failed to release the notification claim for run ${input.runId}: ${
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError)
            }`,
          );
        },
      );
    }
  }

  if (!delivered) {
    return;
  }

  console.log(
    `[turnProviderError] Reported provider error to ${provider} thread for run ${input.runId}`,
  );
}

/**
 * Envelope-driven entry point: fires when the harness persists the assistant
 * message carrying a terminal provider error. Swallows its own errors so chat
 * delivery can never break message persistence.
 */
export async function maybeNotifySourceThreadOfTerminalProviderError(input: {
  runId: number;
  taskId: string;
  envelope: AcpPersistedEnvelope;
}): Promise<void> {
  const errorSummary = getEnvelopeTerminalProviderError(input.envelope);

  if (!errorSummary) {
    return;
  }

  try {
    await notifySourceThreadOfTerminalProviderError({
      runId: input.runId,
      taskId: input.taskId,
      ts: input.envelope.ts,
      errorSummary,
    });
  } catch (error) {
    console.warn(
      `[turnProviderError] Failed to report provider error to the source thread for run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
