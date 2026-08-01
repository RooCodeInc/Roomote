import { decryptText } from '../encryption';
import { db } from '../db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  mondayAgentInstallations,
  type MondayAgentInstallationStatus,
} from '../schema';

export type MondayAgentInstallationSummary = {
  id: string;
  accountId: string;
  accountName: string | null;
  agentId: string;
  ownerMcpConnectionId: string;
  status: MondayAgentInstallationStatus;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toSummary(
  installation: typeof mondayAgentInstallations.$inferSelect,
): MondayAgentInstallationSummary {
  return {
    id: installation.id,
    accountId: installation.accountId,
    accountName: installation.accountName,
    agentId: installation.agentId,
    ownerMcpConnectionId: installation.ownerMcpConnectionId,
    status: installation.status,
    error: installation.error,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

export async function findMondayAgentInstallation(): Promise<MondayAgentInstallationSummary | null> {
  const installation = await db.query.mondayAgentInstallations.findFirst({
    where: eq(mondayAgentInstallations.singletonKey, 'default'),
  });
  return installation ? toSummary(installation) : null;
}

export async function findMondayAgentInstallations(): Promise<
  MondayAgentInstallationSummary[]
> {
  const installations = await db.query.mondayAgentInstallations.findMany();
  return installations.map(toSummary);
}

export async function findMondayAgentRecoveryInstallations(): Promise<
  MondayAgentInstallationSummary[]
> {
  const installations = await db.query.mondayAgentInstallations.findMany({
    where: isNull(mondayAgentInstallations.singletonKey),
  });
  return installations.map(toSummary);
}

export async function findMondayAgentInstallationByAgentId(
  agentId: string,
): Promise<MondayAgentInstallationSummary | null> {
  const installation = await db.query.mondayAgentInstallations.findFirst({
    where: eq(mondayAgentInstallations.agentId, agentId),
  });
  return installation ? toSummary(installation) : null;
}

export async function getMondayAgentInstallationSecrets(agentId: string) {
  const installation = await db.query.mondayAgentInstallations.findFirst({
    where: eq(mondayAgentInstallations.agentId, agentId),
  });
  if (
    !installation ||
    !installation.agentApiToken ||
    !installation.signingSecret
  ) {
    return null;
  }

  return {
    ...toSummary(installation),
    agentApiToken: decryptText(installation.agentApiToken),
    signingSecret: decryptText(installation.signingSecret),
  };
}

export async function hasMondayAgentInstallationForOwnerConnection(
  ownerMcpConnectionId: string,
): Promise<boolean> {
  const installation = await db.query.mondayAgentInstallations.findFirst({
    where: and(
      eq(mondayAgentInstallations.ownerMcpConnectionId, ownerMcpConnectionId),
      eq(mondayAgentInstallations.singletonKey, 'default'),
    ),
    columns: { id: true },
  });
  return Boolean(installation);
}
