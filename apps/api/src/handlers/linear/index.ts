import crypto from 'node:crypto';

import { Hono } from 'hono';

import {
  type TaskPayload,
  TaskPayloadKind,
  formatErrorForLog,
  parseAcpRequestUserInputAnswerReply,
  ALL_REPOSITORIES,
  populateSnapshotResumeSlackMetadata,
  PRODUCT_NAME,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  type RoutingDebugInfo,
  type RoutingWorkspace,
  enqueueTask,
  routeTask,
  buildLinearRoutingContext,
  isDynamicKickoffMessageEnabled,
} from '@roomote/cloud-agents/server';
import { buildTaskStartingText } from '@roomote/communication/chat-messages';
import { getRedis } from '@roomote/redis';
import { postRouterDebugMessage } from '@roomote/slack';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';
import {
  createMcpOauthReplay,
  findLinearDeploymentMcpConnectionByIdentity,
  findLinearUserMcpConnectionByIdentity,
  getLinearDeploymentMetadata,
  getValidAccessToken,
  LINEAR_USER_CONNECTION_ROLE,
} from '@roomote/sdk/server';
import {
  type AgentSessionEventPayload,
  verifyLinearWebhookSignature,
  isWebhookTimestampValid,
  createLinearClient,
  LinearClient,
  findActiveLinearTaskRun,
  findCompletedLinearTaskRunWithSnapshot,
  queueLinearMessage,
  getPendingLinearRequestUserInput,
  clearPendingLinearRequestUserInput,
  markPendingLinearRequestUserInputSubmitted,
  queueLinearRequestUserInputAnswer,
  cancelLinearTaskRun,
  parseAgentSessionEventPayload,
  createLinearAgentRun,
  startElicitationFallback,
  findPendingSelection,
  handleElicitationResponse,
  deletePendingSelection,
  enrichSessionComments,
  type CreateLinearAgentRunResult,
} from '@roomote/linear';

import type { WebhookResponse } from '../../types';
import { syncActingUserForInboundMessage } from '../tasks/acting-user-sync.js';

import { recordLinearWebhook } from './recordWebhook';

function describeLinearRunResult(
  runResult: Exclude<CreateLinearAgentRunResult, { status: 'error' }>,
): string {
  return `task run ${runResult.runId}`;
}

async function updateLinearSessionTaskUrlForDirectLaunch({
  linearClient,
  sessionId,
  runResult,
}: {
  linearClient: LinearClient;
  sessionId: string;
  runResult: Exclude<CreateLinearAgentRunResult, { status: 'error' }>;
}): Promise<void> {
  await linearClient.updateSessionExternalUrls(sessionId, [
    {
      label: 'Open task',
      url: `${Env.R_APP_URL}/task/${runResult.taskId}`,
    },
  ]);
}

/**
 * Get the base URL for auth links.
 * Uses R_APP_URL which is already set per-environment (ngrok in dev, production URLs in prod).
 */
function getAuthBaseUrl(): string {
  return Env.R_APP_URL;
}

async function findLinearDeploymentMcpConnectionByOrganizationId(
  linearOrganizationId: string,
) {
  return findLinearDeploymentMcpConnectionByIdentity({ linearOrganizationId });
}

/**
 * Generate a secure random token for auth flow.
 */
function generateAuthToken(): string {
  return crypto.randomUUID();
}

/**
 * Auth token expiration time (15 minutes).
 */
const AUTH_TOKEN_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Result of workspace mapping that properly distinguishes between
 * repository names and environment IDs.
 */
interface WorkspaceSelection {
  repo?: string;
  environmentId?: string;
}

/**
 * Maps a routing workspace to the appropriate repo/environmentId fields.
 *
 * @param workspace - The workspace selection from the LLM router
 * @returns Object with either repo or environmentId populated
 */
function mapWorkspaceToSelection(
  workspace: RoutingWorkspace,
): WorkspaceSelection {
  switch (workspace.type) {
    case 'environment':
      return { environmentId: workspace.id };
    case 'all_repositories':
      return { repo: ALL_REPOSITORIES };
  }
}

/**
 * Derives the workspace type from a WorkspaceSelection.
 */
function deriveWorkspaceType(
  ws: WorkspaceSelection,
): 'environment' | 'all_repositories' {
  if (ws.environmentId) return 'environment';
  return 'all_repositories';
}

/**
 * Maps an elicitation workspace type + value to the appropriate WorkspaceSelection.
 */
function mapElicitationWorkspaceToSelection(
  workspaceType: 'environment' | 'all',
  value: string,
): WorkspaceSelection {
  switch (workspaceType) {
    case 'environment':
      return { environmentId: value };
    case 'all':
      return { repo: ALL_REPOSITORIES };
  }
}

function formatLinearRouterDebugSource(payload: AgentSessionEventPayload) {
  return `Linear ${payload.agentSession.issue.identifier}`;
}

function getLinearTaskDescription(payload: AgentSessionEventPayload): string {
  return (
    payload.agentSession.issue.description || payload.agentSession.issue.title
  );
}

function postLinearFinalRouterDebug({
  payload,
  selectedWorkspace,
  reasoning,
  routingDebug,
  routingDurationMs,
  userRoute,
}: {
  payload: AgentSessionEventPayload;
  selectedWorkspace: { name: string; type: string };
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
}) {
  void postRouterDebugMessage({
    source: formatLinearRouterDebugSource(payload),
    taskDescription: getLinearTaskDescription(payload),
    selectedWorkspace,
    reasoning: reasoning ?? '',
    routingDebug,
    routingDurationMs,
    userRoute,
  });
}

interface RoutedLinearTask {
  workspaceSelection: WorkspaceSelection;
  workspaceDisplayName: string;
  workspaceType: 'environment' | 'all_repositories';
  kickoffMessage?: string;
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
}

async function startLinearTask({
  linearClient,
  payload,
  userId,
  routedTask,
  agentSession,
}: {
  linearClient: LinearClient;
  payload: AgentSessionEventPayload;
  userId: string;
  routedTask: RoutedLinearTask;
  agentSession: AgentSessionEventPayload['agentSession'];
}): Promise<WebhookResponse> {
  const sessionId = payload.agentSession.id;

  await linearClient.emitThought(
    sessionId,
    buildTaskStartingText({
      workspaceDisplayName: routedTask.workspaceDisplayName,
      kickoffMessage: routedTask.kickoffMessage,
      freeformKickoffEnabled: await isDynamicKickoffMessageEnabled(),
    }),
    true,
  );

  const runResult = await createLinearAgentRun({
    agentSession,
    payload,
    userId,
    repo: routedTask.workspaceSelection.repo,
    environmentId: routedTask.workspaceSelection.environmentId,
  });

  if (runResult.status === 'error') {
    console.error(
      `[LinearWebhook] Failed to create task run for session ${sessionId}: ${runResult.message}`,
    );

    await linearClient.emitError(
      sessionId,
      `Failed to start agent: ${runResult.message}`,
    );

    return { status: 'error', message: runResult.message };
  }

  postLinearFinalRouterDebug({
    payload,
    selectedWorkspace: {
      name: routedTask.workspaceDisplayName,
      type: routedTask.workspaceType,
    },
    reasoning: routedTask.reasoning,
    routingDebug: routedTask.routingDebug,
    routingDurationMs: routedTask.routingDurationMs,
    userRoute: routedTask.userRoute,
  });

  await updateLinearSessionTaskUrlForDirectLaunch({
    linearClient,
    sessionId,
    runResult,
  });

  console.log(
    `[LinearWebhook] Created ${describeLinearRunResult(runResult)} for session ${sessionId}`,
  );

  return { status: 'ok' };
}

export const linear = new Hono();

/**
 * Linear Agent Session Webhook Handler
 *
 * Handles AgentSessionEvent webhooks from Linear:
 * - created: Initial session creation when agent is delegated an issue or mentioned
 * - prompted: Follow-up prompts in the same session
 *
 * The handler must emit a "thought" activity within 10 seconds to acknowledge receipt.
 */
linear.post('/', async (c) => {
  const headers = c.req.header();
  const rawBody = await c.req.text();

  // Extract Linear-Delivery header for idempotency (unique per delivery)
  const deliveryId = headers['linear-delivery'];
  if (!deliveryId) {
    console.error('[LinearWebhook] Missing Linear-Delivery header');
    return c.json({ error: 'Missing delivery ID' }, { status: 400 });
  }

  // Verify webhook signature
  const signature = headers['linear-signature'] ?? '';
  const webhookSecret = Env.R_LINEAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[LinearWebhook] R_LINEAR_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  if (!verifyLinearWebhookSignature(rawBody, signature, webhookSecret)) {
    console.error('[LinearWebhook] Invalid webhook signature');
    return c.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawBody);
  } catch (error) {
    console.error(
      `[LinearWebhook] Failed to parse webhook JSON: ${formatErrorForLog(error)}`,
    );
    return c.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const parseResult = parseAgentSessionEventPayload(parsedJson);

  if (!parseResult.success) {
    console.error(
      '[LinearWebhook] Invalid webhook payload structure:',
      parseResult.error,
    );
    return c.json({ error: 'Invalid payload structure' }, { status: 400 });
  }

  const payload = parseResult.data;

  // Validate webhook type
  if (payload.type !== 'AgentSessionEvent') {
    console.log(
      `[LinearWebhook] Ignoring non-AgentSessionEvent: ${payload.type}`,
    );
    return c.json({ ok: true });
  }

  // Validate timestamp to prevent replay attacks
  if (!isWebhookTimestampValid(payload.webhookTimestamp)) {
    console.error('[LinearWebhook] Webhook timestamp is invalid or expired');
    return c.json({ error: 'Webhook timestamp expired' }, { status: 400 });
  }

  const { organizationId, agentSession, action, agentActivity } = payload;

  // Check for signal in the agent activity (e.g., stop signal from user)
  const signal = agentActivity?.signal;

  console.log(
    `[LinearWebhook] AgentSessionEvent -> ` +
      `action: ${action}, ` +
      `sessionId: ${agentSession.id}, ` +
      `organizationId: ${organizationId}, ` +
      `issueId: ${agentSession.issue.identifier}, ` +
      `creatorId: ${agentSession.creator?.id ?? 'unknown'}` +
      (signal ? `, signal: ${signal}` : ''),
  );

  // Use Linear-Delivery header for idempotency (unique per webhook delivery)
  await recordLinearWebhook(
    deliveryId,
    `agent_session.${action}`,
    payload,
    async () => {
      return handleAgentSessionEvent(payload);
    },
  );

  return c.json({ ok: true });
});

/**
 * Handle an AgentSessionEvent webhook
 */
async function handleAgentSessionEvent(
  payload: AgentSessionEventPayload,
): Promise<WebhookResponse> {
  const { organizationId, agentSession, action, agentActivity } = payload;
  const sessionId = agentSession.id;

  // Extract signal from agent activity (e.g., stop signal from user)
  const signal = agentActivity?.signal;

  const deploymentConnection =
    await findLinearDeploymentMcpConnectionByOrganizationId(organizationId);
  const deploymentMetadata = getLinearDeploymentMetadata(
    deploymentConnection?.authConfig,
  );

  if (!deploymentConnection || !deploymentMetadata?.linearOrganizationId) {
    console.error(
      `[LinearWebhook] No active Linear MCP connection found for org: ${organizationId}`,
    );
    return { status: 'error', message: 'Linear connection not found' };
  }

  const accessToken = await getValidAccessToken(
    deploymentConnection.id,
    'https://mcp.linear.app/mcp',
  );

  if (!accessToken) {
    console.error(
      `[LinearWebhook] Failed to get valid access token for org: ${organizationId} - token may be expired and refresh failed`,
    );
    return {
      status: 'error',
      message: `Linear authentication has expired. Please reconnect the Linear integration in ${PRODUCT_NAME} settings.`,
    };
  }

  // Create Linear client to emit activities
  const linearClient = createLinearClient(accessToken);

  // Check for stop signal - handle it immediately without further processing
  // Stop signals are allowed even if user isn't linked (to cancel task runs started before auth was required)
  if (signal === 'stop') {
    console.log(
      `[LinearWebhook] Received stop signal for session ${sessionId}`,
    );

    return handleStopSignal(sessionId, linearClient, agentSession.issue.id);
  }

  // Extract Linear user ID from the webhook payload - always use agentSession.creator
  const linearUserId = agentSession.creator?.id;

  if (!linearUserId) {
    console.error(
      `[LinearWebhook] No Linear user ID found for session ${sessionId} - agentSession.creator is missing`,
    );
    await linearClient.emitError(
      sessionId,
      'Unable to identify the user who sent this request. Please try again.',
    );
    return { status: 'error', message: 'No Linear user ID in payload' };
  }

  // Check if this Linear user is linked to a Roomote account
  console.log(
    `[LinearWebhook] Checking user mapping for linearUserId=${linearUserId}`,
  );

  const userMapping = await findLinearUserMcpConnectionByIdentity({
    linearUserId,
    linearOrganizationId: organizationId,
  });

  console.log(
    `[LinearWebhook] User mapping result: ${userMapping ? `found (userId=${userMapping.userId})` : 'not found'}`,
  );

  if (!userMapping) {
    console.log(
      `[LinearWebhook] Linear user ${linearUserId} not linked - emitting auth signal`,
    );

    const authToken = generateAuthToken();

    await createMcpOauthReplay({
      token: authToken,
      payload, // Store the original payload to replay after auth
      userId: null,
      mcpId: 'linear',
      connectionId: null,
      connectionRole: LINEAR_USER_CONNECTION_ROLE,
      sessionId,
      redirectTo: null,
      metadata: {
        linearUserId,
        linearOrganizationId: organizationId,
      },
      expiresAt: new Date(Date.now() + AUTH_TOKEN_EXPIRY_MS),
    });

    const authUrl = `${getAuthBaseUrl()}/api/mcp-oauth/replay/${authToken}`;
    console.log(`[LinearWebhook] Auth URL created for session ${sessionId}`);

    // Emit an auth elicitation signal
    console.log(
      `[LinearWebhook] Emitting auth elicitation for session ${sessionId}`,
    );
    const authResult = await linearClient.emitElicitation(
      sessionId,
      `Please link your ${PRODUCT_NAME} account to continue.`,
      {
        signal: 'auth',
        signalMetadata: {
          url: authUrl,
          userId: linearUserId,
          providerName: PRODUCT_NAME,
        },
      },
    );

    console.log(
      `[LinearWebhook] Auth elicitation result: ${JSON.stringify(authResult)}`,
    );

    if (!authResult.success) {
      console.error(
        `[LinearWebhook] Failed to emit auth signal: ${authResult.error}`,
      );
    }

    return { status: 'ok' };
  }

  // User is linked - update userId to the linked user
  const userId = userMapping.userId;
  if (!userId) {
    console.error(
      `[LinearWebhook] Linear link for user ${linearUserId} is missing a Roomote user id`,
    );
    await linearClient.emitError(
      sessionId,
      'Your Linear account link is incomplete. Please reconnect your account and try again.',
    );
    return { status: 'error', message: 'Linked user id is missing' };
  }

  console.log(
    `[LinearWebhook] Linear user ${linearUserId} is linked to Roomote user ${userId}`,
  );

  // Check if this is a follow-up prompt for an existing session
  if (action === 'prompted') {
    // First, check for an active task run. When a job is running (e.g. waiting
    // on ask_followup_question), the user's reply must be delivered to it
    // immediately. This takes priority over routing confirmation and
    // elicitation checks which are only relevant before a job starts.
    const activeRun = await findActiveLinearTaskRun(
      sessionId,
      agentSession.issue.id,
    );

    if (activeRun) {
      console.log(
        `[LinearWebhook] Found active task run ${activeRun.id} for session ${sessionId} - queuing message`,
      );

      // Also clean up any stale pending elicitation selection.
      await deletePendingSelection(sessionId);

      const pendingRequest = await getPendingLinearRequestUserInput(sessionId);

      if (pendingRequest) {
        if (pendingRequest.runId !== activeRun.id) {
          await clearPendingLinearRequestUserInput(sessionId, {
            requestId: pendingRequest.requestId,
          }).catch(() => {});
        } else if (pendingRequest.status === 'submitted') {
          await linearClient.emitThought(
            sessionId,
            'I already received your answer. Please wait for the agent to continue.',
            true,
          );
          return { status: 'ok' };
        } else {
          const responseText = agentActivity?.content?.body ?? '';
          const parsedReply = parseAcpRequestUserInputAnswerReply(
            pendingRequest.questions,
            responseText,
          );

          if (parsedReply) {
            // Question answers return before the normal active-message actor
            // sync below, so apply the trusted sender before marking the
            // request submitted. Otherwise the worker drops a different
            // linked user's answer as a mismatch and it cannot be resent.
            await setTrustedRunActingUserOnSuccess({
              runId: activeRun.id,
              userId,
              operation: async () => {
                await queueLinearRequestUserInputAnswer(activeRun.id, {
                  requestId: pendingRequest.requestId,
                  answers: parsedReply.answers,
                  userId,
                  timestamp: Date.now(),
                });

                await markPendingLinearRequestUserInputSubmitted(
                  sessionId,
                  pendingRequest.requestId,
                );

                return true;
              },
            });

            return { status: 'ok' };
          }
          // Not a recognizable answer: fall through and deliver the reply to
          // the agent as a normal message instead of blocking it behind the
          // pending question.
        }
      }

      // Trusted pre-queue actor switch; see acting-user-sync.ts. The worker
      // only runs the queued turn as this sender if the server actor matches.
      await syncActingUserForInboundMessage({
        logContext: 'linear.activeRunMessage',
        runId: activeRun.id,
        senderUserId: userId,
      });
      // Queue the message for the running worker to pick up
      await queueLinearMessage(activeRun.id, sessionId, payload, userId);

      return { status: 'ok' };
    }

    // Next, check if this is a response to a pending elicitation (backward compat)
    const pendingSelection = await findPendingSelection(sessionId);

    if (pendingSelection) {
      console.log(
        `[LinearWebhook] Found pending selection for session ${sessionId}, step: ${pendingSelection.step}`,
      );

      // Get the response text from the user's activity
      const responseText = agentActivity?.content?.body ?? '';

      if (!responseText) {
        console.log(
          `[LinearWebhook] No response text in prompted action for pending selection`,
        );
        // Re-prompt the user
        await linearClient.emitElicitation(
          sessionId,
          'Please select an option from the list above.',
        );
        return { status: 'ok' };
      }

      // Handle the elicitation response
      const elicitationResult = await handleElicitationResponse({
        sessionId,
        responseText,
        linearClient,
      });

      if (elicitationResult.status === 'completed') {
        console.log(
          `[LinearWebhook] Elicitation completed for session ${sessionId} - ` +
            `workspace repo: ${elicitationResult.repo}`,
        );

        // Clean up the pending selection
        await deletePendingSelection(sessionId);

        // Emit a thought to acknowledge
        await linearClient.emitThought(sessionId, 'Starting task...', true);

        // Get the original payload from the pending selection
        const originalPayload = elicitationResult.pendingSelection
          .payload as unknown as AgentSessionEventPayload;

        // Enrich the original payload's session with all issue comments (including external ones)
        const enrichedElicitationSession = await enrichSessionComments(
          linearClient,
          originalPayload.agentSession,
        );

        // Create the standard task run with the selected workspace.
        const elicitationWorkspace = mapElicitationWorkspaceToSelection(
          elicitationResult.workspaceType,
          elicitationResult.repo,
        );
        const runResult = await createLinearAgentRun({
          agentSession: enrichedElicitationSession,
          payload: originalPayload,
          userId,
          repo: elicitationWorkspace.repo,
          environmentId: elicitationWorkspace.environmentId,
        });

        if (runResult.status === 'error') {
          console.error(
            `[LinearWebhook] Failed to create task run: ${runResult.message}`,
          );
          await linearClient.emitError(
            sessionId,
            `Failed to start agent: ${runResult.message}`,
          );
          return { status: 'error', message: runResult.message };
        }

        console.log(
          `[LinearWebhook] Created ${describeLinearRunResult(runResult)} for session ${sessionId}`,
        );

        await updateLinearSessionTaskUrlForDirectLaunch({
          linearClient,
          sessionId,
          runResult,
        });

        return { status: 'ok' };
      }

      if (elicitationResult.status === 'awaiting_workspace') {
        console.log(
          `[LinearWebhook] Elicitation awaiting workspace selection for session ${sessionId}`,
        );
        return { status: 'ok' };
      }

      if (elicitationResult.status === 'error') {
        console.error(
          `[LinearWebhook] Elicitation error for session ${sessionId}: ${elicitationResult.message}`,
        );

        await linearClient.emitError(
          sessionId,
          `Something went wrong. Please try again.`,
        );

        await deletePendingSelection(sessionId);
        return { status: 'error', message: elicitationResult.message };
      }

      // not_found - fall through to normal flow
    }

    // No active task run found - check for a completed task run with snapshot to resume from
    console.log(
      `[LinearWebhook] No active task run for session ${sessionId} - checking for snapshot resume`,
    );

    const completedRun = await findCompletedLinearTaskRunWithSnapshot(
      agentSession.issue.id,
    );

    if (completedRun && completedRun.snapshotId) {
      console.log(
        `[LinearWebhook] Found completed task run ${completedRun.id} with snapshot ${completedRun.snapshotId} - creating SnapshotResume run`,
      );

      // Acquire a short-lived distributed lock on the issue ID to prevent
      // concurrent webhook deliveries from creating duplicate resume task runs.
      const redis = getRedis();
      const lockKey = `linear:resume-lock:${agentSession.issue.id}`;
      const lockTTLSeconds = 30;

      const acquired = await redis.set(
        lockKey,
        '1',
        'EX',
        lockTTLSeconds,
        'NX',
      );

      if (!acquired) {
        console.log(
          `[LinearWebhook] Resume lock already held for issue ${agentSession.issue.id} - polling for resume task run`,
        );

        // Another handler is already creating the resume task run. Poll for
        // the new active task run so we can queue the message to the correct
        // (resume) job ID instead of the completed source task run.
        const POLL_INTERVAL_MS = 500;
        const MAX_POLL_ATTEMPTS = 10;
        let resumeRun: Awaited<ReturnType<typeof findActiveLinearTaskRun>> =
          null;

        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          resumeRun = await findActiveLinearTaskRun(
            sessionId,
            agentSession.issue.id,
          );

          if (resumeRun) {
            console.log(
              `[LinearWebhook] Found resume task run ${resumeRun.id} after ${attempt} poll attempt(s)`,
            );

            break;
          }
        }

        if (resumeRun) {
          await queueLinearMessage(resumeRun.id, sessionId, payload, userId);
        } else {
          console.warn(
            `[LinearWebhook] Could not find resume task run for issue ${agentSession.issue.id} after ${MAX_POLL_ATTEMPTS} attempts - message may be lost`,
          );
        }

        return { status: 'ok' };
      }

      try {
        const completedPayload = completedRun.payload as Record<
          string,
          unknown
        >;

        const repo =
          typeof completedPayload?.repo === 'string'
            ? completedPayload.repo
            : ALL_REPOSITORIES;

        const environmentId =
          typeof completedPayload?.environmentId === 'string'
            ? completedPayload.environmentId
            : undefined;
        const resumePayload: TaskPayload<
          typeof TaskPayloadKind.SnapshotResume
        > = {
          repo,
          environmentId,
          port: completedRun.port ?? undefined,
          sourceSnapshotId: completedRun.snapshotId,
          sourceRunId: completedRun.id,
        };
        populateSnapshotResumeSlackMetadata(resumePayload, {
          sourcePayload: completedPayload,
          threadTs: completedRun.slackThreadTs,
        });
        restoreSnapshotResumeVisiblePromptFields(
          resumePayload,
          completedPayload,
        );

        // Resumes never create tasks and never re-attribute; the resuming
        // human becomes the new run's acting user.
        const resumeLaunch = await enqueueTask(
          {
            task: {
              type: TaskPayloadKind.SnapshotResume,
              sourceSnapshotId: completedRun.snapshotId,
              sourceRunId: completedRun.id,
              payload: resumePayload,
            },
            actingUserId: userId ?? completedRun.actingUserId ?? null,
          },
          {},
        );

        await queueLinearMessage(resumeLaunch.id, sessionId, payload, userId);

        await linearClient.updateSessionExternalUrl(
          sessionId,
          `${Env.R_APP_URL}/task/${resumeLaunch.taskId}`,
        );

        console.log(
          `[LinearWebhook] Created snapshot resume task run ${resumeLaunch.id} for session ${sessionId}`,
        );

        // Emit thought so user sees activity
        await linearClient.emitThought(
          sessionId,
          `Sorry for the delay. Reconnecting you with ${PRODUCT_NAME}...`,
          true,
        );

        return { status: 'ok' };
      } catch (error) {
        // Release the lock on failure so a retry can attempt resume again.
        await redis.del(lockKey).catch(() => {});

        console.error(
          `[LinearWebhook] Failed to create snapshot resume task run for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Fall through to fresh job creation.
      }
    } else {
      console.log(
        `[LinearWebhook] No completed task run with snapshot for session ${sessionId} - creating new task run`,
      );
    }
  }

  // Immediately emit a "thought" activity to acknowledge receipt (only for new task runs)
  const thoughtResult = await linearClient.emitThought(
    sessionId,
    'Getting started...',
    true,
  );

  if (!thoughtResult.success) {
    console.error(
      `[LinearWebhook] Failed to emit thought for session ${sessionId}: ${thoughtResult.error}`,
    );

    // Continue anyway - the thought is nice to have but not critical
  }

  // Enrich the session with all issue comments (including external ones from GitHub, Slack, etc.)
  // This must happen before LLM routing and job creation so all comment context is available.
  const enrichedSession = await enrichSessionComments(
    linearClient,
    agentSession,
  );

  let workspaceSelection: WorkspaceSelection = { repo: ALL_REPOSITORIES };

  console.log(`[LinearWebhook] Attempting to route Linear task`);

  try {
    // Production routing already resolves the correct workspace, so keep the
    // existing Linear task description input and only change the kickoff flow.
    const taskDescription =
      agentSession.comment?.body ||
      agentSession.issue.description ||
      agentSession.issue.title;

    // Build routing context with all relevant Linear data
    const routingContext = await buildLinearRoutingContext({
      userId,
      taskDescription,
      issueIdentifier: agentSession.issue.identifier,
      issueTitle: agentSession.issue.title,
      issueDescription: agentSession.issue.description,
      projectName: agentSession.issue.project?.name,
      teamName: agentSession.issue.team?.name,
      guidance: agentSession.guidance,
      previousComments: enrichedSession.previousComments?.map((c) => ({
        body: c.body,
        username: c.user?.name,
      })),
      apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
    });

    // Attempt LLM routing
    const routingStart = Date.now();
    const routingDecision = await routeTask(routingContext);
    const routingDurationMs = Date.now() - routingStart;

    if (routingDecision.status === 'platform_answer') {
      const responseResult = await linearClient.emitResponse(
        sessionId,
        routingDecision.result.answer,
      );

      if (!responseResult.success) {
        console.error(
          `[LinearWebhook] Failed to emit platform answer to Linear: ${responseResult.error}`,
        );
      }

      return { status: 'ok' };
    }

    if (routingDecision.status === 'routed') {
      const { result } = routingDecision;

      console.log(
        `[LinearWebhook] LLM routing decision: ` +
          `workspace=${result.workspace.type}${result.workspace.type === 'environment' ? `(${result.workspace.name})` : ''}, ` +
          `reasoning="${result.reasoning}"`,
      );

      const ws = mapWorkspaceToSelection(result.workspace);

      const wsDesc =
        ws.repo === ALL_REPOSITORIES
          ? 'all repos'
          : ws.repo ||
            (result.workspace.type === 'environment'
              ? result.workspace.name
              : `environment(${ws.environmentId})`);

      return startLinearTask({
        linearClient,
        payload,
        userId,
        routedTask: {
          workspaceSelection: ws,
          workspaceDisplayName: wsDesc,
          workspaceType: deriveWorkspaceType(ws),
          ...(result.kickoffMessage
            ? { kickoffMessage: result.kickoffMessage }
            : {}),
          reasoning: result.reasoning,
          routingDebug: result.debug,
          routingDurationMs,
        },
        agentSession: enrichedSession,
      });
    } else {
      console.log(
        `[LinearWebhook] LLM routing fell back: ${routingDecision.reason}`,
      );
    }
  } catch (routingError) {
    console.error(
      `[LinearWebhook] LLM routing error, falling back to default:`,
      routingError instanceof Error
        ? routingError.message
        : String(routingError),
    );
  }

  // If routing was not used or failed, use the elicitation fallback flow
  console.log(
    `[LinearWebhook] LLM routing not available or failed, starting elicitation fallback for session ${sessionId}`,
  );

  const fallbackResult = await startElicitationFallback({
    sessionId,
    linearOrganizationId: organizationId,
    userId,
    payload,
    linearClient,
  });

  if (fallbackResult.status === 'error') {
    console.error(
      `[LinearWebhook] Elicitation fallback error: ${fallbackResult.message}`,
    );

    const errorResult = await linearClient.emitError(
      sessionId,
      `Failed to start workspace selection: ${fallbackResult.message}`,
    );

    if (!errorResult.success) {
      console.error(
        `[LinearWebhook] Failed to emit error to Linear: ${errorResult.error}`,
      );
    }

    return { status: 'error', message: fallbackResult.message };
  }

  // Check if the elicitation completed immediately (e.g., only one workspace)
  if (fallbackResult.pendingSelection.step === 'completed') {
    const selectedRepo =
      fallbackResult.pendingSelection.selectedRepo ?? ALL_REPOSITORIES;

    const wsOptions = fallbackResult.pendingSelection
      .workspaceOptions as Array<{
      type: 'all' | 'environment';
      id: string;
      name: string;
    }> | null;

    const matchedWs = wsOptions?.find((ws) => ws.id === selectedRepo);

    if (matchedWs?.type === 'environment') {
      workspaceSelection = { environmentId: matchedWs.id };
    } else if (selectedRepo === ALL_REPOSITORIES) {
      workspaceSelection = { repo: ALL_REPOSITORIES };
    } else {
      workspaceSelection = { repo: selectedRepo };
    }

    console.log(
      `[LinearWebhook] Elicitation auto-completed with workspace=${JSON.stringify(workspaceSelection)}`,
    );

    await deletePendingSelection(sessionId);
  } else {
    console.log(
      `[LinearWebhook] Elicitation started, awaiting workspace selection for session ${sessionId}`,
    );

    return { status: 'ok' };
  }

  // Create the task run
  const runResult = await createLinearAgentRun({
    agentSession: enrichedSession,
    payload,
    userId,
    repo: workspaceSelection.repo,
    environmentId: workspaceSelection.environmentId,
  });

  if (runResult.status === 'error') {
    console.error(
      `[LinearWebhook] Failed to create task run: ${runResult.message}`,
    );

    const errorResult = await linearClient.emitError(
      sessionId,
      `Failed to start agent: ${runResult.message}`,
    );

    if (!errorResult.success) {
      console.error(
        `[LinearWebhook] Failed to emit error to Linear: ${errorResult.error}`,
      );
    }

    return { status: 'error', message: runResult.message };
  }

  console.log(
    `[LinearWebhook] Created ${describeLinearRunResult(runResult)} for session ${sessionId}`,
  );

  await updateLinearSessionTaskUrlForDirectLaunch({
    linearClient,
    sessionId,
    runResult,
  });

  return { status: 'ok' };
}

/**
 * Handle a stop signal from the user.
 *
 * The stop signal instructs the agent to halt work immediately.
 * This function will:
 * 1. Cancel any active task run for the session
 * 2. Clear any pending messages in the queue
 * 3. Emit a response to Linear confirming the stop
 */
async function handleStopSignal(
  sessionId: string,
  linearClient: LinearClient,
  linearIssueId?: string,
): Promise<WebhookResponse> {
  try {
    // Find any active task run for this session (or same issue via fallback)
    const activeRun = await findActiveLinearTaskRun(sessionId, linearIssueId);

    if (activeRun) {
      console.log(
        `[LinearWebhook] Canceling active task run ${activeRun.id} for session ${sessionId}`,
      );

      // Cancel the job and clear the message queue
      const cancelResult = await cancelLinearTaskRun(activeRun, sessionId);

      if (!cancelResult.success) {
        console.error(
          `[LinearWebhook] Failed to cancel task run ${activeRun.id}: ${cancelResult.error}`,
        );

        const errorResult = await linearClient.emitError(
          sessionId,
          `Failed to stop: ${cancelResult.error}`,
        );

        if (!errorResult.success) {
          console.error(
            `[LinearWebhook] Failed to emit error to Linear: ${errorResult.error}`,
          );
        }

        return {
          status: 'error',
          message: cancelResult.error ?? 'Failed to cancel task run',
        };
      }

      // Emit a response confirming the stop
      const responseResult = await linearClient.emitResponse(
        sessionId,
        'Work has been stopped as requested. The agent has halted all ongoing tasks.',
      );

      if (!responseResult.success) {
        console.error(
          `[LinearWebhook] Failed to emit response to Linear: ${responseResult.error}`,
        );
      }

      console.log(
        `[LinearWebhook] Successfully stopped job ${activeRun.id} for session ${sessionId}`,
      );
    } else {
      console.log(
        `[LinearWebhook] No active task run found for session ${sessionId}`,
      );

      // No active task run means no queue to clear (queue is keyed by runId)
      // Emit a response confirming the stop
      const responseResult = await linearClient.emitResponse(
        sessionId,
        'No active work to stop. The agent is now idle.',
      );

      if (!responseResult.success) {
        console.error(
          `[LinearWebhook] Failed to emit response to Linear: ${responseResult.error}`,
        );
      }
    }

    return { status: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[LinearWebhook] Error handling stop signal for session ${sessionId}: ${message}`,
    );

    const errorResult = await linearClient.emitError(
      sessionId,
      `Failed to stop: ${message}`,
    );

    if (!errorResult.success) {
      console.error(
        `[LinearWebhook] Failed to emit error to Linear: ${errorResult.error}`,
      );
    }

    return { status: 'error', message };
  }
}
