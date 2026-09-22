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
import { resolveDecisionModel } from '@roomote/cloud-agents/server/typesafe-judgment';
import {
  getMcpIntegration,
  isInternalMcpServer,
  type IntegrationToolAutoSettings,
  type IntegrationToolPoliciesUpsert,
  type IntegrationToolPolicyMode,
  type IntegrationToolPolicyUpsert,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Internal MCPs (Roomote's own server, the HTTP integrations broker, Brain
 * memory) are excluded from approval control; reject attempts to configure
 * them and hide any previously stored rows for them.
 */
function assertApprovalManagedIntegrationId(integrationId: string) {
  if (isInternalMcpServer(integrationId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${integrationId} is a Roomote-internal MCP server and is outside approval control.`,
    });
  }
}

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval policies.
 * Deployment-scoped and admin-managed: every session on the deployment runs
 * under these modes while the experiment is enabled.
 */
export async function listIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return (await listIntegrationToolPolicies()).filter(
    (policy) => !isInternalMcpServer(policy.integrationId),
  );
}

export async function setIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  assertAdmin(auth);
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolPolicy({
    ...input,
    updatedByUserId: auth.userId,
  });
  await syncLegacyDisabledTool({ ...input, scope: 'deployment' });
  return listIntegrationToolPoliciesCommand(auth);
}

export async function setIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  assertAdmin(auth);
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolPolicies({
    ...input,
    updatedByUserId: auth.userId,
  });
  await syncLegacyDisabledTools({ ...input, scope: 'deployment' });
  return listIntegrationToolPoliciesCommand(auth);
}

const toolApprovalsEnabled = () =>
  isDeploymentExperimentEnabled('integrationToolApprovals');

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
 * deployment policies and only ever tighten them. Inert while the experiment
 * is off.
 */
export async function listPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  if (!(await toolApprovalsEnabled())) return [];
  return (await listIntegrationToolUserPolicies(auth.userId)).filter(
    (policy) => !isInternalMcpServer(policy.integrationId),
  );
}

export async function setPersonalIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Tool approvals are not enabled.',
    });
  }
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolUserPolicy({ ...input, userId: auth.userId });
  await syncLegacyDisabledTool({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listPersonalIntegrationToolPoliciesCommand(auth);
}

export async function setPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Tool approvals are not enabled.',
    });
  }
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolUserPolicies({ ...input, userId: auth.userId });
  await syncLegacyDisabledTools({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listPersonalIntegrationToolPoliciesCommand(auth);
}

/**
 * Deployment-wide Auto mode, admin only. `model` names what Auto will
 * consult, so an admin sees the cost of turning it on: the hosted judgment
 * model, or the helper model when none is configured.
 */
export async function getIntegrationToolAutoSettingsCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  const [settings, model] = await Promise.all([
    getIntegrationToolAutoSettings(),
    resolveDecisionModel().catch(() => null),
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
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Integration tool approvals are not enabled.',
    });
  }
  await setIntegrationToolAutoSettings({
    mode: input.mode,
    policy: input.policy.trim(),
  });
  return getIntegrationToolAutoSettingsCommand(auth);
}
