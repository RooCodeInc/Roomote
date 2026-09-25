import { TRPCError } from '@trpc/server';

import {
  and,
  customMcpServers,
  db,
  deploymentMcpEnablements,
  eq,
  getIntegrationToolAutoSettings,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
  personalMcpServers,
  setIntegrationToolAutoSettings,
  upsertIntegrationToolPolicies,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicies,
  upsertIntegrationToolUserPolicy,
} from '@roomote/db/server';
import { AUTO_DECISION_REQUIREMENTS } from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';
import { resolveDecisionModel } from '@roomote/cloud-agents/server/typesafe-judgment';
import {
  getMcpIntegration,
  type IntegrationToolAutoSettings,
  type IntegrationToolPoliciesUpsert,
  type IntegrationToolPolicyMode,
  type IntegrationToolPolicyUpsert,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Per-tool approval policies. Deployment-scoped and admin-managed: every
 * session on the deployment runs under these modes.
 */
export async function listIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return listIntegrationToolPolicies();
}

export async function setIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  assertAdmin(auth);
  await upsertIntegrationToolPolicy({
    ...input,
    updatedByUserId: auth.userId,
  });
  await syncLegacyDisabledTool({ ...input, scope: 'deployment' });
  return listIntegrationToolPolicies();
}

export async function setIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  assertAdmin(auth);
  await upsertIntegrationToolPolicies({
    ...input,
    updatedByUserId: auth.userId,
  });
  await syncLegacyDisabledTools({ ...input, scope: 'deployment' });
  return listIntegrationToolPolicies();
}

const autoApprovalsEnabled = (auth: UserAuthSuccess) =>
  auth.nightlyExperimentsEnabled === true &&
  isDeploymentExperimentEnabled('integrationToolAutoApprovals');

/**
 * Keep pre-policy availability rows compatible while the policy surface rolls
 * them into the `reject`/Disable mode. The columns remain for N-1 rollback;
 * current policy edits are the only user-facing source of truth.
 */
async function syncLegacyDisabledTool(input: {
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  scope: 'deployment' | 'personal';
  userId?: string;
}) {
  return syncLegacyDisabledTools({ ...input, toolNames: [input.toolName] });
}

async function syncLegacyDisabledTools(input: {
  integrationId: string;
  toolNames: string[];
  mode: IntegrationToolPolicyMode;
  scope: 'deployment' | 'personal';
  userId?: string;
}) {
  if (input.scope === 'personal') {
    if (!input.userId) return;
    const server = await db.query.personalMcpServers.findFirst({
      where: and(
        eq(personalMcpServers.ownerUserId, input.userId),
        eq(personalMcpServers.name, input.integrationId),
      ),
      columns: { id: true, disabledTools: true },
    });
    if (!server) return;

    const disabledTools = new Set(server.disabledTools ?? []);
    for (const toolName of input.toolNames) {
      if (input.mode === 'reject') disabledTools.add(toolName);
      else disabledTools.delete(toolName);
    }

    await db
      .update(personalMcpServers)
      .set({
        disabledTools:
          disabledTools.size > 0 ? [...disabledTools].sort() : null,
        updatedAt: new Date(),
      })
      .where(eq(personalMcpServers.id, server.id));
    return;
  }

  if (getMcpIntegration(input.integrationId)) {
    const enablement = await db.query.deploymentMcpEnablements.findFirst({
      where: eq(deploymentMcpEnablements.mcpId, input.integrationId),
      columns: { mcpId: true, disabledTools: true },
    });
    if (!enablement) return;

    const disabledTools = new Set(enablement.disabledTools ?? []);
    for (const toolName of input.toolNames) {
      if (input.mode === 'reject') disabledTools.add(toolName);
      else disabledTools.delete(toolName);
    }

    await db
      .update(deploymentMcpEnablements)
      .set({
        disabledTools:
          disabledTools.size > 0 ? [...disabledTools].sort() : null,
        updatedAt: new Date(),
      })
      .where(eq(deploymentMcpEnablements.mcpId, enablement.mcpId));
    return;
  }

  const server = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.name, input.integrationId),
    columns: { id: true, disabledTools: true },
  });
  if (!server) return;

  const disabledTools = new Set(server.disabledTools ?? []);
  for (const toolName of input.toolNames) {
    if (input.mode === 'reject') disabledTools.add(toolName);
    else disabledTools.delete(toolName);
  }

  await db
    .update(customMcpServers)
    .set({
      disabledTools: disabledTools.size > 0 ? [...disabledTools].sort() : null,
      updatedAt: new Date(),
    })
    .where(eq(customMcpServers.id, server.id));
}

/**
 * The caller's personal policies for their own Sessions. They layer on the
 * deployment policies and only ever tighten them.
 */
export async function listPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  return listIntegrationToolUserPolicies(auth.userId);
}

export async function setPersonalIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  await upsertIntegrationToolUserPolicy({ ...input, userId: auth.userId });
  await syncLegacyDisabledTool({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listIntegrationToolUserPolicies(auth.userId);
}

export async function setPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  await upsertIntegrationToolUserPolicies({ ...input, userId: auth.userId });
  await syncLegacyDisabledTools({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listIntegrationToolUserPolicies(auth.userId);
}

/**
 * Deployment-wide Auto mode, admin only. `model` names what Auto will
 * consult: Jev, or null when there is no Jev backend (the helper model and
 * the model Roomote trains are not used for Auto yet).
 */
export async function getIntegrationToolAutoSettingsCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  if (!(await autoApprovalsEnabled(auth))) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Auto tool approvals are not enabled.',
    });
  }
  const [settings, model] = await Promise.all([
    getIntegrationToolAutoSettings(),
    resolveDecisionModel(AUTO_DECISION_REQUIREMENTS).catch(() => null),
  ]);
  return {
    ...settings,
    model:
      model === null
        ? null
        : model.kind === 'judgment'
          ? { kind: 'judgment' as const }
          : { kind: 'helper' as const, model: model.model },
  };
}

export async function setIntegrationToolAutoSettingsCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolAutoSettings,
) {
  assertAdmin(auth);
  if (!(await autoApprovalsEnabled(auth))) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Auto tool approvals are not enabled.',
    });
  }
  await setIntegrationToolAutoSettings({
    mode: input.mode,
    policy: input.policy.trim(),
  });
  return getIntegrationToolAutoSettingsCommand(auth);
}
