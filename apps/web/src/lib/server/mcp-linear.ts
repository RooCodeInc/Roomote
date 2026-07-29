import { LinearClient } from '@linear/sdk';

import {
  db,
  mcpConnections,
  eq,
  deploymentMcpEnablements,
} from '@roomote/db/server';
import {
  consumeMcpOauthReplay,
  findLinearDeploymentMcpConnection,
  getMcpOauthReplay,
  getValidAccessToken,
  getLinearDeploymentMetadata,
  LINEAR_ORG_CONNECTION_ROLE,
  LINEAR_USER_CONNECTION_ROLE,
} from '@roomote/sdk/server';
import {
  createLinearAgentRun,
  createLinearClient,
  enrichSessionComments,
  parseAgentSessionEventPayload,
} from '@roomote/linear';

type McpConnectionRecord = Awaited<
  ReturnType<typeof db.query.mcpConnections.findFirst>
>;

function replayMatchesLinearIdentity(
  replay: { mcpId: string; metadata: unknown },
  identity: { linearOrganizationId: string; linearUserId: string },
) {
  if (
    replay.mcpId !== 'linear' ||
    !replay.metadata ||
    typeof replay.metadata !== 'object'
  ) {
    return false;
  }

  const metadata = replay.metadata as Record<string, unknown>;
  return (
    metadata.linearOrganizationId === identity.linearOrganizationId &&
    metadata.linearUserId === identity.linearUserId
  );
}

async function updateLinearConnectionMetadata(input: {
  connection: NonNullable<McpConnectionRecord>;
  linearOrganizationId: string;
  linearOrganizationName?: string | null;
  linearOrganizationUrlKey?: string | null;
  appUserId?: string;
  linearUserId?: string;
}) {
  const authConfig =
    input.connection.authConfig &&
    typeof input.connection.authConfig === 'object'
      ? (input.connection.authConfig as Record<string, unknown>)
      : {};

  await db
    .update(mcpConnections)
    .set({
      authConfig: {
        ...authConfig,
        linearOrganizationId: input.linearOrganizationId,
        linearOrganizationName: input.linearOrganizationName ?? null,
        linearOrganizationUrlKey: input.linearOrganizationUrlKey ?? null,
        ...(input.appUserId ? { appUserId: input.appUserId } : {}),
        ...(input.linearUserId ? { linearUserId: input.linearUserId } : {}),
      } as NonNullable<McpConnectionRecord>['authConfig'],
      updatedAt: new Date(),
    })
    .where(eq(mcpConnections.id, input.connection.id));
}

async function resumeLinearReplay(input: {
  replayToken: string;
  userId: string;
  linearOrganizationId: string;
  linearUserId: string;
}) {
  const replay = await consumeMcpOauthReplay(input.replayToken);
  if (!replay) {
    return;
  }

  if (!replayMatchesLinearIdentity(replay, input)) {
    return;
  }

  if (!replay.payload || typeof replay.sessionId !== 'string') {
    return;
  }

  const parseResult = parseAgentSessionEventPayload(replay.payload);
  if (!parseResult.success) {
    return;
  }

  const deploymentConnection = await findLinearDeploymentMcpConnection();
  const deploymentMetadata = getLinearDeploymentMetadata(
    deploymentConnection?.authConfig,
  );
  if (!deploymentConnection || !deploymentMetadata) {
    return;
  }

  const deploymentAccessToken = await getValidAccessToken(
    deploymentConnection.id,
    'https://mcp.linear.app/mcp',
  );
  if (!deploymentAccessToken) {
    throw new Error('Failed to resolve the Linear app access token');
  }

  const linearClient = createLinearClient(deploymentAccessToken);
  const payload = parseResult.data;
  const sessionId = payload.agentSession.id;

  await linearClient.emitThought(sessionId, 'Getting started...', true);

  const enrichedSession = await enrichSessionComments(
    linearClient,
    payload.agentSession,
  );

  const runResult = await createLinearAgentRun({
    agentSession: enrichedSession,
    payload,
    userId: input.userId,
  });

  if (runResult.status === 'error') {
    await linearClient.emitError(
      sessionId,
      `Failed to start agent: ${runResult.message}`,
    );
    return;
  }

  if ('taskId' in runResult) {
    const baseUrl = process.env.R_APP_URL;
    if (baseUrl) {
      await linearClient.updateSessionExternalUrls(sessionId, [
        { label: 'Open task', url: `${baseUrl}/task/${runResult.taskId}` },
      ]);
    }
  }
}

export async function hydrateLinearMcpConnectionAfterOauth(input: {
  connection: NonNullable<McpConnectionRecord>;
  accessToken: string;
  replayToken?: string | null;
  enabledByUserId?: string;
}) {
  const viewerClient = new LinearClient({ accessToken: input.accessToken });
  const viewer = await viewerClient.viewer;
  const organization = await viewer.organization;

  if (!viewer.id || !organization?.id) {
    throw new Error('Failed to resolve Linear viewer or organization metadata');
  }

  if (input.connection.connectionRole === LINEAR_ORG_CONNECTION_ROLE) {
    await updateLinearConnectionMetadata({
      connection: input.connection,
      linearOrganizationId: organization.id,
      linearOrganizationName: organization.name,
      linearOrganizationUrlKey: organization.urlKey ?? null,
      appUserId: viewer.id,
    });

    if (input.enabledByUserId) {
      await db
        .insert(deploymentMcpEnablements)
        .values({
          mcpId: 'linear',
          enabled: true,
          enabledByUserId: input.enabledByUserId,
        })
        .onConflictDoUpdate({
          target: deploymentMcpEnablements.mcpId,
          set: {
            enabled: true,
            enabledByUserId: input.enabledByUserId,
            updatedAt: new Date(),
          },
        });
    }

    return;
  }

  if (input.connection.connectionRole === LINEAR_USER_CONNECTION_ROLE) {
    if (input.replayToken) {
      const replay = await getMcpOauthReplay(input.replayToken);
      if (
        !replay ||
        !replayMatchesLinearIdentity(replay, {
          linearOrganizationId: organization.id,
          linearUserId: viewer.id,
        })
      ) {
        throw new Error(
          'The authorized Linear account does not match the requested session',
        );
      }
    }

    await updateLinearConnectionMetadata({
      connection: input.connection,
      linearOrganizationId: organization.id,
      linearUserId: viewer.id,
    });

    if (input.replayToken && input.connection.userId) {
      await resumeLinearReplay({
        replayToken: input.replayToken,
        userId: input.connection.userId,
        linearOrganizationId: organization.id,
        linearUserId: viewer.id,
      });
    }
  }
}
