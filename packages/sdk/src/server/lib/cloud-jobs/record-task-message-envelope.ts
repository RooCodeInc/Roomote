import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  LLM_TITLE_LOCKED_CHECKPOINT,
} from '@roomote/cloud-agents/server';
import {
  db,
  taskMessages,
  taskPlatformIssueReports,
  tasks,
  cloudJobs,
  getBackgroundAgentSettings,
  slackInstallations,
  normalizeTaskActivityTimestamp,
  eq,
  and,
  inArray,
  isNull,
  lt,
  asc,
  sql,
  resolveManagerSlackChannelId,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  SlackNotifier,
  setLatestSlackBotReply,
  trackSlackBotReply,
} from '@roomote/slack';
import { appendManagerSlackFooter } from '../manager-slack';
import {
  type AcpPersistedEnvelope,
  ACP_ENVELOPE_EVENT_TYPES,
  asBoolean,
  asRecord,
  asString,
  extractVisibleAcpPromptText,
  extractAcpMessageText,
  getRequestedDeploymentEnvVarNamesFromToolPayload,
  isExitedCloudTaskStatus,
  isSystemInjectedAcpPromptText,
  isVisibleInTranscript,
  normalizeTranscriptUserText,
  platformIssueReportSchema,
  withTranscriptVisibility,
} from '@roomote/types';

import {
  detectPullRequestsFromToolResultEnvelope,
  persistDetectedPullRequest,
} from './extract-pull-requests';
import { resolveSlackJobRouting } from './slack-job-routing';
import { withSandboxServerRpcClient } from '../auth/sandbox-server-rpc';

interface RecordTaskMessageEnvelopeInput {
  cloudJobId: number;
  taskId: string;
  userId?: string;
  envelope: AcpPersistedEnvelope;
}

const TITLE_CHECKPOINTS = [1, 4, 20] as const;
const TITLE_MAX_CHECKPOINT = 20;
type LlmTitleCheckpoint =
  | (typeof TITLE_CHECKPOINTS)[number]
  | typeof LLM_TITLE_LOCKED_CHECKPOINT
  | 0;

const TITLE_TRANSCRIPT_EVENT_TYPES = [
  ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
] as const;
const pendingTaskTitleRefreshes = new Map<string, Promise<void>>();
const REPORT_PLATFORM_ISSUE_TOOL_NAME = 'report_platform_issue';
const ENV_VAR_REQUEST_SLACK_KEY_PREFIX = 'slack:env_var_request:';
const SETUP_ENV_VAR_REQUEST_SLACK_CAMPAIGN = 'setup.secure_env_vars.request';
const ENV_VAR_REQUEST_SLACK_CAMPAIGN = 'env_vars.request';
const ENV_VAR_REQUEST_SLACK_TTL_SECONDS = 7 * 24 * 60 * 60;
function getPersistedUserId(
  envelope: AcpPersistedEnvelope,
  fallbackUserId?: string,
): string | null {
  if (envelope.role !== 'user') {
    return null;
  }

  const metadata = asRecord(envelope.metadata);
  const payload = asRecord(envelope.payload);

  return (
    asString(metadata?.userId) ??
    asString(payload?.userId) ??
    fallbackUserId ??
    null
  );
}

async function getCloudJobRepoFallback(input: {
  cloudJobId: number;
  taskId: string;
}): Promise<string | null> {
  const [job] = await db
    .select({
      prRepo: cloudJobs.prRepo,
      payload: cloudJobs.payload,
    })
    .from(cloudJobs)
    .where(
      and(
        eq(cloudJobs.id, input.cloudJobId),
        eq(cloudJobs.taskId, input.taskId),
      ),
    )
    .limit(1);

  const payload = asRecord(job?.payload);

  return job?.prRepo ?? asString(payload?.repo) ?? null;
}

function getPlatformIssueReportFromToolPayload(
  payload: Record<string, unknown> | null,
) {
  if (!payload || asBoolean(payload.isMcp) !== true) {
    return null;
  }

  const toolName = asString(payload.toolName) ?? asString(payload.mcpToolName);

  if (toolName !== REPORT_PLATFORM_ISSUE_TOOL_NAME) {
    return null;
  }

  const output = asString(payload.output);

  if (!output) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const result = asRecord(parsed);

  if (!result || asBoolean(result.success) !== true) {
    return null;
  }

  const parsedReport = platformIssueReportSchema.safeParse(result.report);

  if (!parsedReport.success) {
    return null;
  }

  return parsedReport.data;
}

function buildPlatformIssueTaskUrl(taskId: string): string {
  const url = new URL(`/task/${taskId}`, process.env.ROOMOTE_APP_URL);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'integration');
  url.searchParams.set('utm_campaign', 'platform_issue_alert');

  return url.toString();
}

async function maybeNotifyPlatformIssueToSlack(params: {
  reportRowId: string;
  taskId: string;
  report: { title: string; summary: string };
  slackPostedAt: Date | null;
}): Promise<void> {
  if (params.slackPostedAt) {
    return;
  }

  const [settings, slackInstallation] = await Promise.all([
    getBackgroundAgentSettings(),
    db.query.slackInstallations.findFirst({
      where: and(eq(slackInstallations.isActive, true)),
      columns: {
        botAccessToken: true,
        isActive: true,
      },
    }),
  ]);

  const channelId = resolveManagerSlackChannelId(
    {
      managerSlackChannelId: settings.managerSlackChannelId ?? null,
      platformIssueSlackChannelId: settings.platformIssueSlackChannelId ?? null,
    },
    'platformIssue',
  );

  if (!channelId) {
    return;
  }

  if (!slackInstallation?.botAccessToken || !slackInstallation.isActive) {
    console.warn(
      `[recordTaskMessageEnvelope] No active Slack installation, skipping platform issue Slack alert for task ${params.taskId}`,
    );
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const taskUrl = buildPlatformIssueTaskUrl(params.taskId);

  const messageTs = await slack.postMessage({
    channel: channelId,
    text: appendManagerSlackFooter(
      `Platform issue reported: *${params.report.title}*\n` +
        `> ${params.report.summary}\n<${taskUrl}|View task>`,
    ),
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!messageTs) {
    console.warn(
      `[recordTaskMessageEnvelope] Failed to post platform issue Slack alert for task ${params.taskId}`,
    );
    return;
  }

  await db
    .update(taskPlatformIssueReports)
    .set({ slackPostedAt: new Date() })
    .where(
      and(
        eq(taskPlatformIssueReports.id, params.reportRowId),
        isNull(taskPlatformIssueReports.slackPostedAt),
      ),
    );
}

async function maybePersistPlatformIssueReport(params: {
  input: RecordTaskMessageEnvelopeInput;
  taskMessageId: string;
}): Promise<void> {
  const report = getPlatformIssueReportFromToolPayload(
    asRecord(params.input.envelope.payload) ?? null,
  );

  if (!report) {
    return;
  }

  const [insertedRow] = await db
    .insert(taskPlatformIssueReports)
    .values({
      taskId: params.input.taskId,
      cloudJobId: params.input.cloudJobId,
      taskMessageId: params.taskMessageId,
      report,
    })
    .onConflictDoUpdate({
      target: taskPlatformIssueReports.taskMessageId,
      set: {
        taskId: params.input.taskId,
        cloudJobId: params.input.cloudJobId,
        report,
      },
    })
    .returning({
      id: taskPlatformIssueReports.id,
      taskId: taskPlatformIssueReports.taskId,
      report: taskPlatformIssueReports.report,
      slackPostedAt: taskPlatformIssueReports.slackPostedAt,
    });

  const reportRow =
    insertedRow ??
    (await db.query.taskPlatformIssueReports.findFirst({
      where: eq(taskPlatformIssueReports.taskMessageId, params.taskMessageId),
      columns: {
        id: true,
        taskId: true,
        report: true,
        slackPostedAt: true,
      },
    }));

  if (!reportRow) {
    return;
  }

  await maybeNotifyPlatformIssueToSlack({
    reportRowId: reportRow.id,
    taskId: reportRow.taskId,
    report: reportRow.report,
    slackPostedAt: reportRow.slackPostedAt,
  });
}

function getRequestedDeploymentEnvVarsFromToolResult(
  envelope: AcpPersistedEnvelope,
): string[] {
  if (envelope.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
    return [];
  }

  const payload = asRecord(envelope.payload);

  return getRequestedDeploymentEnvVarNamesFromToolPayload(payload ?? null).sort(
    (left, right) => left.localeCompare(right),
  );
}

function buildSlackWebPathUrl(webPath: string, campaign: string): string {
  const url = new URL(webPath, process.env.ROOMOTE_APP_URL);

  url.searchParams.set('utm_source', 'slack');
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', campaign);

  return url.toString();
}

function getRequestedDeploymentEnvVarNamesKey(
  requestedNames: string[],
): string {
  return requestedNames.join(',');
}

function getEnvVarRequestSlackNotificationKey(
  taskId: string,
  requestedNames: string[],
): string {
  return `${ENV_VAR_REQUEST_SLACK_KEY_PREFIX}${taskId}:${getRequestedDeploymentEnvVarNamesKey(requestedNames)}`;
}

function buildEnvVarRequestSlackText(
  requestedNames: string[],
  actionUrl: string,
): string {
  const formattedNames = requestedNames.map((name) => `\`${name}\``).join(', ');
  const usesSingular = requestedNames.length === 1;

  return `I need ${usesSingular ? 'this environment variable' : 'these environment variables'} to continue: ${formattedNames}. Enter ${usesSingular ? 'it' : 'them'} securely in <${actionUrl}|the web app>.`;
}

async function maybeNotifySlackAboutEnvVarRequest(params: {
  input: RecordTaskMessageEnvelopeInput;
  requestedNames: string[];
}): Promise<void> {
  const { input, requestedNames } = params;

  const [job] = await db
    .select({
      id: cloudJobs.id,
      payload: cloudJobs.payload,
      slackThreadTs: cloudJobs.slackThreadTs,
      sourceCloudJobId: cloudJobs.sourceCloudJobId,
    })
    .from(cloudJobs)
    .where(
      and(
        eq(cloudJobs.id, input.cloudJobId),
        eq(cloudJobs.taskId, input.taskId),
      ),
    )
    .limit(1);

  if (!job) {
    return;
  }

  const { channel, threadTs, route } = await resolveSlackJobRouting(job);

  if (!channel || !threadTs) {
    return;
  }

  const dedupeKey = getEnvVarRequestSlackNotificationKey(
    input.taskId,
    requestedNames,
  );
  const redis = getRedis();
  const claimed = await redis.set(
    dedupeKey,
    '1',
    'EX',
    ENV_VAR_REQUEST_SLACK_TTL_SECONDS,
    'NX',
  );

  if (!claimed) {
    return;
  }

  try {
    const slackInstallation = await db.query.slackInstallations.findFirst({
      columns: { botAccessToken: true },
      where: and(eq(slackInstallations.isActive, true)),
    });

    if (!slackInstallation?.botAccessToken) {
      console.warn(
        `[recordTaskMessageEnvelope] No active Slack installation, skipping env-var Slack reply for task ${input.taskId}`,
      );
      return;
    }

    const actionUrl = buildSlackWebPathUrl(
      route.kind === 'setup-onboarding'
        ? route.webPath
        : `/task/${input.taskId}`,
      route.kind === 'setup-onboarding'
        ? SETUP_ENV_VAR_REQUEST_SLACK_CAMPAIGN
        : ENV_VAR_REQUEST_SLACK_CAMPAIGN,
    );
    const text = buildEnvVarRequestSlackText(requestedNames, actionUrl);
    const slack = new SlackNotifier(slackInstallation.botAccessToken);
    const messageTs = await slack.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!messageTs) {
      console.warn(
        `[recordTaskMessageEnvelope] Failed to post env-var Slack reply for task ${input.taskId}`,
      );
      await redis.del(dedupeKey);
      return;
    }

    const [trackResult, latestReplyResult] = await Promise.allSettled([
      trackSlackBotReply(channel, threadTs, messageTs),
      setLatestSlackBotReply(channel, threadTs, messageTs, text),
    ]);

    if (trackResult.status === 'rejected') {
      console.warn(
        `[recordTaskMessageEnvelope] Failed to track env-var Slack reply for task ${input.taskId}: ${
          trackResult.reason instanceof Error
            ? trackResult.reason.message
            : String(trackResult.reason)
        }`,
      );
    }

    if (latestReplyResult.status === 'rejected') {
      console.warn(
        `[recordTaskMessageEnvelope] Failed to persist latest env-var Slack reply for task ${input.taskId}: ${
          latestReplyResult.reason instanceof Error
            ? latestReplyResult.reason.message
            : String(latestReplyResult.reason)
        }`,
      );
    }
  } catch (error) {
    await redis.del(dedupeKey).catch(() => {});
    throw error;
  }
}

async function maybeStopTaskAfterEnvVarRequest(
  input: RecordTaskMessageEnvelopeInput,
): Promise<void> {
  const requestedNames = getRequestedDeploymentEnvVarsFromToolResult(
    input.envelope,
  );

  if (requestedNames.length === 0) {
    return;
  }

  const [job] = await db
    .select({
      id: cloudJobs.id,
      status: cloudJobs.status,
      sandboxServerUrl: cloudJobs.sandboxServerUrl,
      userId: cloudJobs.userId,
      actingUserId: cloudJobs.actingUserId,
    })
    .from(cloudJobs)
    .where(
      and(
        eq(cloudJobs.id, input.cloudJobId),
        eq(cloudJobs.taskId, input.taskId),
      ),
    )
    .limit(1);

  if (!job || isExitedCloudTaskStatus(job.status) || !job.sandboxServerUrl) {
    return;
  }

  const tokenUserId = input.userId ?? job.actingUserId ?? job.userId;

  if (!tokenUserId) {
    return;
  }

  await withSandboxServerRpcClient({
    cloudJobId: job.id,
    userId: tokenUserId,
    sandboxServerUrl: job.sandboxServerUrl,
    call: (client) => client.commands.cancelTask.mutate(),
  });
}

async function maybeHandleRequestedDeploymentEnvVars(
  input: RecordTaskMessageEnvelopeInput,
): Promise<void> {
  const requestedNames = getRequestedDeploymentEnvVarsFromToolResult(
    input.envelope,
  );

  if (requestedNames.length === 0) {
    return;
  }

  const [slackReplyResult, stopResult] = await Promise.allSettled([
    maybeNotifySlackAboutEnvVarRequest({ input, requestedNames }),
    maybeStopTaskAfterEnvVarRequest(input),
  ]);

  if (slackReplyResult.status === 'rejected') {
    console.warn(
      `[recordTaskMessageEnvelope] Failed to post env-var Slack reply for task ${input.taskId}: ${
        slackReplyResult.reason instanceof Error
          ? slackReplyResult.reason.message
          : String(slackReplyResult.reason)
      }`,
    );
  }

  if (stopResult.status === 'rejected') {
    console.warn(
      `[recordTaskMessageEnvelope] Failed to request resumable stop for task ${input.taskId}: ${
        stopResult.reason instanceof Error
          ? stopResult.reason.message
          : String(stopResult.reason)
      }`,
    );
  }
}

function getDesiredCheckpoint(userMessageCount: number): LlmTitleCheckpoint {
  let checkpoint: LlmTitleCheckpoint = 0;

  for (const threshold of TITLE_CHECKPOINTS) {
    if (userMessageCount >= threshold) {
      checkpoint = threshold;
    }
  }

  return checkpoint;
}

function normalizeTitleTranscriptText(value: string | undefined): string {
  if (!value) {
    return '';
  }

  return normalizeTranscriptUserText(value)?.replace(/\s+/g, ' ').trim() ?? '';
}

async function maybeRefreshTaskTitle(input: RecordTaskMessageEnvelopeInput) {
  if (input.envelope.eventType !== ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
    return;
  }

  await refreshTaskTitle({
    taskId: input.taskId,
    cloudJobId: input.cloudJobId,
    userId: input.userId,
    mode: 'checkpoint',
  });
}

async function refreshTaskTitle(input: {
  taskId: string;
  cloudJobId: number;
  userId?: string;
  mode: 'checkpoint' | 'final';
}) {
  const [taskRow] = await db
    .select({
      titleEditedByUserAt: tasks.titleEditedByUserAt,
      llmTitleCheckpoint: tasks.llmTitleCheckpoint,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);

  if (!taskRow || taskRow.titleEditedByUserAt) {
    return;
  }

  const transcriptRows = await db
    .select({
      eventType: taskMessages.eventType,
      contentBlocks: taskMessages.contentBlocks,
      metadata: taskMessages.metadata,
      payload: taskMessages.payload,
      ts: taskMessages.ts,
      createdAt: taskMessages.createdAt,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, input.taskId),
        inArray(taskMessages.eventType, [...TITLE_TRANSCRIPT_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(taskMessages.ts), asc(taskMessages.createdAt));

  let visibleUserMessageCount = 0;
  let shouldUnwrapInitialInjectedUserPrompt = true;

  const messages = transcriptRows.reduce<
    Array<{ role: 'user' | 'assistant'; text: string }>
  >((acc, row) => {
    const isUserPrompt = row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt;
    const rawText =
      extractAcpMessageText(row.contentBlocks, asRecord(row.payload) ?? null) ??
      undefined;
    const isInitialUserPrompt =
      isUserPrompt && shouldUnwrapInitialInjectedUserPrompt;

    if (isUserPrompt) {
      shouldUnwrapInitialInjectedUserPrompt = false;
    }

    const text = normalizeTitleTranscriptText(
      isInitialUserPrompt && rawText && isSystemInjectedAcpPromptText(rawText)
        ? extractVisibleAcpPromptText(rawText)
        : rawText,
    );

    if (!text) {
      return acc;
    }

    if (isUserPrompt) {
      visibleUserMessageCount += 1;
    }

    acc.push({
      role: isUserPrompt ? 'user' : 'assistant',
      text,
    });

    return acc;
  }, []);

  const desiredCheckpoint: LlmTitleCheckpoint =
    input.mode === 'final'
      ? LLM_TITLE_LOCKED_CHECKPOINT
      : getDesiredCheckpoint(visibleUserMessageCount);

  if (
    desiredCheckpoint === 0 ||
    taskRow.llmTitleCheckpoint >= desiredCheckpoint
  ) {
    return;
  }

  // The completion-time refresh regenerates the title from the full
  // transcript so single-prompt tasks get a better title than their earliest
  // truncated snapshot. Once the task has already reached the highest
  // incremental checkpoint (or the locked sentinel for deterministic titles),
  // the title already reflects the full conversation, so skip the final
  // refresh to avoid biasing it toward wrap-up messages.
  if (
    input.mode === 'final' &&
    taskRow.llmTitleCheckpoint >= TITLE_MAX_CHECKPOINT
  ) {
    return;
  }

  if (messages.length === 0) {
    return;
  }

  const generatedTitle = await generateLlmTaskTitle({
    userId: input.userId,
    taskId: input.taskId,
    messages,
  });
  const shouldPersistGeneratedTitle = !isFallbackTaskTitle(generatedTitle);

  const [updatedTask] = await db
    .update(tasks)
    .set({
      llmTitleCheckpoint: desiredCheckpoint,
      updatedAt: new Date(),
      ...(shouldPersistGeneratedTitle ? { title: generatedTitle } : {}),
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        isNull(tasks.titleEditedByUserAt),
        lt(tasks.llmTitleCheckpoint, desiredCheckpoint),
      ),
    )
    .returning({ id: tasks.id });

  if (!updatedTask) {
    return;
  }

  if (shouldPersistGeneratedTitle) {
    await db
      .update(cloudJobs)
      .set({
        title: generatedTitle,
      })
      .where(
        and(
          eq(cloudJobs.id, input.cloudJobId),
          eq(cloudJobs.taskId, input.taskId),
        ),
      );
  }
}

/**
 * Regenerate the LLM task title from the full transcript when a cloud job
 * reaches a terminal state. Incremental checkpoints only fire on user
 * messages, so single-prompt tasks (e.g. webhook-triggered PR reviews)
 * otherwise keep whatever title was generated from the earliest truncated
 * snapshot even after the task succeeds.
 */
export async function refreshTaskTitleOnCompletion(input: {
  taskId: string;
  cloudJobId: number;
  userId?: string;
}): Promise<void> {
  // Let any in-flight incremental refresh for this task settle first so the
  // final regeneration is last-writer and sees the complete transcript.
  const pendingRefresh = pendingTaskTitleRefreshes.get(input.taskId);

  if (pendingRefresh) {
    await pendingRefresh.catch(() => {});
  }

  await refreshTaskTitle({
    taskId: input.taskId,
    cloudJobId: input.cloudJobId,
    userId: input.userId,
    mode: 'final',
  });
}

function scheduleTaskTitleRefresh(input: RecordTaskMessageEnvelopeInput) {
  const previousRefresh = pendingTaskTitleRefreshes.get(input.taskId);

  const refreshPromise = (previousRefresh ?? Promise.resolve())
    .catch(() => {})
    .then(() => maybeRefreshTaskTitle(input))
    .catch((error) => {
      console.warn(
        `[recordTaskMessageEnvelope] Failed to refresh title for task ${
          input.taskId
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      if (pendingTaskTitleRefreshes.get(input.taskId) === refreshPromise) {
        pendingTaskTitleRefreshes.delete(input.taskId);
      }
    });

  pendingTaskTitleRefreshes.set(input.taskId, refreshPromise);
}

export async function recordTaskMessageEnvelope(
  input: RecordTaskMessageEnvelopeInput,
): Promise<void> {
  const { cloudJobId, taskId, userId, envelope } = input;
  const persistedUserId = getPersistedUserId(envelope, userId);
  const normalizedActivityAt = normalizeTaskActivityTimestamp(envelope.ts);
  const metadata = withTranscriptVisibility(
    envelope.metadata,
    envelope.visibleInTranscript ??
      isVisibleInTranscript(envelope.metadata ?? null),
  );

  const [persistedTaskMessage] = await db
    .insert(taskMessages)
    .values({
      cloudJobId,
      taskId,
      userId: persistedUserId,
      ts: envelope.ts,
      eventType: envelope.eventType,
      role: envelope.role,
      protocol: envelope.protocol,
      contentBlocks: envelope.contentBlocks,
      metadata,
      payload: envelope.payload,
    })
    .onConflictDoUpdate({
      target: [
        taskMessages.taskId,
        taskMessages.protocol,
        taskMessages.ts,
        taskMessages.eventType,
      ],
      set: {
        userId: persistedUserId,
        role: envelope.role,
        contentBlocks: envelope.contentBlocks,
        metadata,
        payload: envelope.payload,
      },
    })
    .returning({ id: taskMessages.id });

  if (!persistedTaskMessage) {
    return;
  }

  await db
    .update(tasks)
    .set({
      activityAt: sql`greatest(${tasks.activityAt}, ${normalizedActivityAt})`,
    })
    .where(eq(tasks.id, taskId));

  scheduleTaskTitleRefresh(input);

  await maybePersistPlatformIssueReport({
    input,
    taskMessageId: persistedTaskMessage.id,
  }).catch((error) => {
    console.warn(
      `[recordTaskMessageEnvelope] Failed to persist platform issue report for task ${
        input.taskId
      }: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  void maybeHandleRequestedDeploymentEnvVars(input);

  const detectedPrs = await detectPullRequestsFromToolResultEnvelope({
    envelope,
    resolveCheckoutFallbackRepository: () =>
      getCloudJobRepoFallback({ cloudJobId, taskId }),
  });

  if (detectedPrs.length === 0) {
    return;
  }

  for (const pr of detectedPrs) {
    try {
      await persistDetectedPullRequest({ taskId, cloudJobId, pr });
    } catch (error) {
      console.warn(
        `[recordTaskMessageEnvelope] Failed to persist detected PR for task ${taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
