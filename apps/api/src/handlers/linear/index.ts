import crypto from 'node:crypto';

import { Hono } from 'hono';

import {
  formatErrorForLog,
  parseAcpRequestUserInputAnswerReply,
  PRODUCT_NAME,
} from '@roomote/types';
import { Env, areCuratedIntegrationsDisabled } from '@roomote/env';
import {
  db,
  resolveDeploymentEnvVar,
  setTrustedRunActingUserOnSuccess,
} from '@roomote/db/server';
import {
  createMcpOauthReplay,
  findLinearDeploymentMcpConnectionByIdentity,
  findLinearUserMcpConnectionByIdentity,
  getLinearDeploymentMetadata,
  getValidAccessToken,
  LINEAR_USER_CONNECTION_ROLE,
  resolveLinearAutomationLaunchUserId,
  startLinearFastSessionTurn,
} from '@roomote/sdk/server';
import {
  type AgentSessionEventPayload,
  verifyLinearWebhookSignature,
  isWebhookTimestampValid,
  createLinearClient,
  LinearClient,
  findActiveLinearTaskRun,
  getPendingLinearRequestUserInput,
  clearPendingLinearRequestUserInput,
  markPendingLinearRequestUserInputSubmitted,
  queueLinearRequestUserInputAnswer,
  cancelLinearTaskRun,
  parseAgentSessionEventPayload,
  enrichSessionComments,
} from '@roomote/linear';

import type { WebhookResponse } from '../../types';

import { recordLinearWebhook } from './recordWebhook';

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

const LINEAR_FAST_UNAVAILABLE_MESSAGE =
  "Roomote couldn't start a conversation right now. Please try again in a moment.";

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
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    return c.body(null, 204);
  }

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
  const webhookSecret = await resolveDeploymentEnvVar(
    'R_LINEAR_WEBHOOK_SECRET',
    db,
    { R_LINEAR_WEBHOOK_SECRET: Env.R_LINEAR_WEBHOOK_SECRET },
  );

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
 * Handle an AgentSessionEvent webhook.
 *
 * Every session event enters the session's Fast Session: the Session reads
 * the issue, replies as agent responses, and delegates work to tasks bound
 * to the session. Only two things bypass it: stop signals, and answers to a
 * question a running task asked through request_user_input.
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

  // Direct issue delegations can omit human identity entirely. The signed
  // webhook and org-level connection establish the trusted automation caller.
  const linearUserId =
    agentSession.creator?.id ?? agentSession.user?.id ?? agentActivity?.userId;

  if (!linearUserId && action === 'prompted') {
    console.error(
      `[LinearWebhook] No Linear user ID found for prompted session ${sessionId}`,
    );
    await linearClient.emitError(
      sessionId,
      'Unable to identify the user who sent this request. Please try again.',
    );
    return { status: 'error', message: 'No Linear user ID in payload' };
  }

  let userId: string | undefined;

  if (linearUserId) {
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

    if (!userMapping.userId) {
      console.error(
        `[LinearWebhook] Linear link for user ${linearUserId} is missing a Roomote user id`,
      );
      await linearClient.emitError(
        sessionId,
        'Your Linear account link is incomplete. Please reconnect your account and try again.',
      );
      return { status: 'error', message: 'Linked user id is missing' };
    }

    userId = userMapping.userId;
    console.log(
      `[LinearWebhook] Linear user ${linearUserId} is linked to Roomote user ${userId}`,
    );
  } else {
    // A trusted delegation with no human runs in a Session owned by the
    // deployment's first administrator.
    const automationUserId = await resolveLinearAutomationLaunchUserId();
    if (!automationUserId) {
      console.error(
        `[LinearWebhook] No administrator available to own the automation session ${sessionId}`,
      );
      await linearClient.emitError(
        sessionId,
        `No ${PRODUCT_NAME} administrator is available to run this request.`,
      );
      return { status: 'error', message: 'No automation launch identity' };
    }
    userId = automationUserId;
    console.log(
      `[LinearWebhook] Starting trusted Linear automation for session ${sessionId} as user ${userId}`,
    );
  }

  // A running task that asked a question through request_user_input owns
  // the next reply. Everything else in the session belongs to Fast.
  if (action === 'prompted') {
    const activeRun = await findActiveLinearTaskRun(
      sessionId,
      agentSession.issue.id,
    );
    const pendingRequest = activeRun
      ? await getPendingLinearRequestUserInput(sessionId)
      : null;

    if (activeRun && pendingRequest) {
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
          const answerUserId = userId;
          // Apply the trusted sender before marking the request submitted.
          // Otherwise the worker drops a different linked user's answer as
          // a mismatch and it cannot be resent.
          await setTrustedRunActingUserOnSuccess({
            runId: activeRun.id,
            userId: answerUserId,
            operation: async () => {
              await queueLinearRequestUserInputAnswer(activeRun.id, {
                requestId: pendingRequest.requestId,
                answers: parsedReply.answers,
                userId: answerUserId,
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
        // Not a recognizable answer: the Session handles it like any other
        // message and can steer the task itself.
      }
    }
  }

  // Linear expects an activity within seconds; the Session's reply follows.
  const thoughtResult = await linearClient.emitThought(
    sessionId,
    action === 'prompted' ? 'Thinking...' : 'Getting started...',
    true,
  );

  if (!thoughtResult.success) {
    console.error(
      `[LinearWebhook] Failed to emit thought for session ${sessionId}: ${thoughtResult.error}`,
    );

    // Continue anyway - the thought is nice to have but not critical
  }

  // The first turn carries the whole discussion, including comments from
  // other integrations; later turns already have that context in the Session.
  const enrichedSession =
    action === 'prompted'
      ? agentSession
      : await enrichSessionComments(linearClient, agentSession);

  const started = await startLinearFastSessionTurn({
    payload,
    agentSession: enrichedSession,
    userId,
    linearClient,
  });

  if (started.status !== 'queued') {
    console.error(
      `[LinearWebhook] Fast entry unavailable for session ${sessionId}: ${started.reason}`,
    );
    await linearClient.emitError(sessionId, LINEAR_FAST_UNAVAILABLE_MESSAGE);
    return { status: 'error', message: started.reason };
  }

  console.log(
    `[LinearWebhook] Session ${sessionId} entered Fast conversation ${started.fastConversationId}`,
  );

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
