import {
  and,
  db,
  eq,
  findMondayAgentInstallation,
  findMondayAgentInstallations,
  getMondayAgentInstallationSecrets,
  mcpConnections,
  mondayAgentInstallations,
} from '@roomote/db/server';
import { MondayClient } from '@roomote/monday';
import { getValidAccessToken } from '@roomote/sdk/server';

import { Env } from '@/lib/server/env';
import type { UserAuthSuccess } from '@/types';

const MONDAY_MCP_URL = 'https://mcp.monday.com/mcp';
const MONDAY_AGENT_NAME = 'Roomote';

function assertMondayAgentAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) throw new Error('Unauthorized');
  if (!Env.R_MONDAY_AGENT_ENABLED) {
    throw new Error('monday.com external-agent beta is not enabled');
  }
}

function getCallbackUrl(): string {
  const baseUrl = Env.R_PUBLIC_URL ?? Env.R_APP_URL;
  return new URL('/api/webhooks/monday/agent', baseUrl).toString();
}

function assertPublicCallbackUrl(callbackUrl: string): void {
  const url = new URL(callbackUrl);
  const invalidHost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.run.app');
  if ((url.protocol !== 'https:' || invalidHost) && Env.NODE_ENV !== 'test') {
    throw new Error(
      'monday.com external agents require a public HTTPS R_PUBLIC_URL',
    );
  }
}

async function getOwnerConnection(auth: UserAuthSuccess) {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.userId, auth.userId),
      eq(mcpConnections.mcpId, 'monday'),
      eq(mcpConnections.connectionRole, 'default'),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });
  if (!connection) {
    throw new Error(
      'Connect your monday.com account in Personal Settings before installing the external agent',
    );
  }

  const accessToken = await getValidAccessToken(connection.id, MONDAY_MCP_URL);
  if (!accessToken) {
    throw new Error('Reconnect your monday.com account before continuing');
  }

  return { connection, accessToken };
}

async function preserveFailedInstallation(input: {
  accountId: string;
  accountName: string;
  agentId: string;
  ownerMcpConnectionId: string;
  agentApiToken: string;
  signingSecret: string;
  error: string;
}): Promise<void> {
  const [primaryRecovery] = await db
    .insert(mondayAgentInstallations)
    .values({
      singletonKey: 'default',
      accountId: input.accountId,
      accountName: input.accountName,
      agentId: input.agentId,
      ownerMcpConnectionId: input.ownerMcpConnectionId,
      agentApiToken: input.agentApiToken,
      signingSecret: input.signingSecret,
      status: 'error',
      error: input.error,
    })
    .onConflictDoNothing()
    .returning({ id: mondayAgentInstallations.id });
  if (primaryRecovery) return;

  await db.insert(mondayAgentInstallations).values({
    singletonKey: null,
    accountId: input.accountId,
    accountName: input.accountName,
    agentId: input.agentId,
    ownerMcpConnectionId: input.ownerMcpConnectionId,
    agentApiToken: input.agentApiToken,
    signingSecret: input.signingSecret,
    status: 'error',
    error: input.error,
  });
  await db
    .update(mondayAgentInstallations)
    .set({ error: input.error, updatedAt: new Date() })
    .where(eq(mondayAgentInstallations.singletonKey, 'default'));
}

export async function getMondayAgentInstallationCommand(auth: UserAuthSuccess) {
  if (!auth.isAdmin || !Env.R_MONDAY_AGENT_ENABLED) {
    return { featureEnabled: false as const, installation: null };
  }

  return {
    featureEnabled: true as const,
    callbackUrl: getCallbackUrl(),
    installation: await findMondayAgentInstallation(),
  };
}

export async function installMondayAgentCommand(auth: UserAuthSuccess) {
  assertMondayAgentAdmin(auth);
  if ((await findMondayAgentInstallations()).length > 0) {
    throw new Error('A monday.com external agent is already installed');
  }

  const { connection, accessToken } = await getOwnerConnection(auth);
  const client = new MondayClient({ token: accessToken });
  const account = await client.getAccount();
  const callbackUrl = getCallbackUrl();
  assertPublicCallbackUrl(callbackUrl);
  const credentials = await client.connectExternalAgent({
    name: MONDAY_AGENT_NAME,
    callbackUrl,
  });

  try {
    const [installation] = await db
      .insert(mondayAgentInstallations)
      .values({
        singletonKey: 'default',
        accountId: account.id,
        accountName: account.name,
        agentId: credentials.agentId,
        ownerMcpConnectionId: connection.id,
        agentApiToken: credentials.apiToken,
        signingSecret: credentials.signingSecret,
        status: 'inactive',
      })
      .returning();
    if (!installation) throw new Error('Installation was not persisted');
    return { success: true as const };
  } catch (persistError) {
    try {
      await client.disconnectExternalAgent(credentials.agentId);
    } catch (cleanupError) {
      const recoveryMessage = `Credential persistence failed and provider cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'}`;
      await preserveFailedInstallation({
        accountId: account.id,
        accountName: account.name,
        agentId: credentials.agentId,
        ownerMcpConnectionId: connection.id,
        agentApiToken: credentials.apiToken,
        signingSecret: credentials.signingSecret,
        error: recoveryMessage,
      });
      throw new Error(recoveryMessage);
    }

    throw new Error(
      `Failed to persist monday.com external agent credentials: ${persistError instanceof Error ? persistError.message : 'unknown persistence error'}`,
    );
  }
}

export async function rotateMondayAgentCredentialsCommand(
  auth: UserAuthSuccess,
) {
  assertMondayAgentAdmin(auth);
  const current = await findMondayAgentInstallation();
  if (!current) throw new Error('No monday.com external agent is installed');

  const { connection, accessToken } = await getOwnerConnection(auth);
  if (current.ownerMcpConnectionId !== connection.id) {
    throw new Error(
      'Only the administrator account that installed the external agent can rotate it',
    );
  }

  const client = new MondayClient({ token: accessToken });
  const currentSecrets = await getMondayAgentInstallationSecrets(
    current.agentId,
  );
  if (!currentSecrets) {
    throw new Error('Installation credentials are unavailable');
  }
  const account = await client.getAccount();
  if (account.id !== current.accountId) {
    throw new Error(
      'The connected monday.com account does not match the installation',
    );
  }
  const callbackUrl = getCallbackUrl();
  assertPublicCallbackUrl(callbackUrl);
  const replacement = await client.connectExternalAgent({
    name: MONDAY_AGENT_NAME,
    callbackUrl,
  });

  try {
    await db
      .update(mondayAgentInstallations)
      .set({
        agentId: replacement.agentId,
        agentApiToken: replacement.apiToken,
        signingSecret: replacement.signingSecret,
        status: 'inactive',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(mondayAgentInstallations.id, current.id));
  } catch (persistError) {
    try {
      await client.disconnectExternalAgent(replacement.agentId);
    } catch (cleanupError) {
      await preserveFailedInstallation({
        accountId: account.id,
        accountName: account.name,
        agentId: replacement.agentId,
        ownerMcpConnectionId: connection.id,
        agentApiToken: replacement.apiToken,
        signingSecret: replacement.signingSecret,
        error: `Credential rotation persistence and cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'}`,
      });
    }
    throw persistError;
  }

  try {
    await client.disconnectExternalAgent(current.agentId);
  } catch (error) {
    await preserveFailedInstallation({
      accountId: current.accountId,
      accountName: current.accountName ?? account.name,
      agentId: current.agentId,
      ownerMcpConnectionId: current.ownerMcpConnectionId,
      agentApiToken: currentSecrets.agentApiToken,
      signingSecret: currentSecrets.signingSecret,
      error: `Replacement installed, but prior agent ${current.agentId} could not be disconnected: ${error instanceof Error ? error.message : 'unknown provider error'}`,
    });
  }

  return { success: true as const };
}

export async function uninstallMondayAgentCommand(auth: UserAuthSuccess) {
  assertMondayAgentAdmin(auth);
  const installations = await findMondayAgentInstallations();
  if (installations.length === 0) return { success: true as const };

  const clients = new Map<string, MondayClient>();
  const failures: string[] = [];
  for (const installation of installations) {
    if (installation.status !== 'disconnected') {
      let client = clients.get(installation.ownerMcpConnectionId);
      if (!client) {
        const accessToken = await getValidAccessToken(
          installation.ownerMcpConnectionId,
          MONDAY_MCP_URL,
        );
        if (!accessToken) {
          failures.push(
            `${installation.agentId}: owner account must reconnect`,
          );
          continue;
        }
        client = new MondayClient({ token: accessToken });
        clients.set(installation.ownerMcpConnectionId, client);
      }

      try {
        await client.disconnectExternalAgent(installation.agentId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown provider error';
        failures.push(`${installation.agentId}: ${message}`);
        await db
          .update(mondayAgentInstallations)
          .set({
            status: 'error',
            error: `Provider disconnect failed: ${message}`,
            updatedAt: new Date(),
          })
          .where(eq(mondayAgentInstallations.id, installation.id));
        continue;
      }

      await db
        .update(mondayAgentInstallations)
        .set({ status: 'disconnected', error: null, updatedAt: new Date() })
        .where(eq(mondayAgentInstallations.id, installation.id));
    }

    try {
      await db
        .delete(mondayAgentInstallations)
        .where(eq(mondayAgentInstallations.id, installation.id));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown local error';
      failures.push(`${installation.agentId}: ${message}`);
      await db
        .update(mondayAgentInstallations)
        .set({
          status: 'disconnected',
          error: `Provider disconnected, but local deletion failed: ${message}`,
          updatedAt: new Date(),
        })
        .where(eq(mondayAgentInstallations.id, installation.id));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Some monday.com agents could not be removed: ${failures.join('; ')}`,
    );
  }
  return { success: true as const };
}
