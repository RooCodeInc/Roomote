import {
  db,
  deploymentSettings,
  environments,
  githubInstallations,
  slackInstallations,
  mcpConnections,
  eq,
  and,
  isNull,
} from '@roomote/db/server';
import { LINEAR_ORG_CONNECTION_ROLE } from '@roomote/sdk/server';
import {
  createEmptySetupNewState,
  normalizeSetupNewState,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
export { getSetupBootstrapState } from '@/lib/server/setup-bootstrap-state';

type SetupBaseStatus = {
  hasGitHub: boolean;
  hasEnvironments: boolean;
  hasSlack: boolean;
  hasLinear: boolean;
  setupCompletedAt: Date | null;
  setupNewState: ReturnType<typeof createEmptySetupNewState>;
};

export function assertAdmin(auth: UserAuthSuccess) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getSetupBaseStatus(
  auth: UserAuthSuccess,
): Promise<SetupBaseStatus> {
  assertAdmin(auth);

  const [
    githubResult,
    environmentResult,
    slackResult,
    linearResult,
    orgResult,
  ] = await Promise.all([
    db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(isNull(githubInstallations.suspendedAt))
      .limit(1),
    db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.isEval, false))
      .limit(1),
    db
      .select({ id: slackInstallations.id })
      .from(slackInstallations)
      .where(eq(slackInstallations.isActive, true))
      .limit(1),
    db
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.mcpId, 'linear'),
          eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
          eq(mcpConnections.authStatus, 'authenticated'),
          isNull(mcpConnections.userId),
        ),
      )
      .limit(1),
    db
      .select({
        setupCompletedAt: deploymentSettings.setupCompletedAt,
        setupNewState: deploymentSettings.setupNewState,
      })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1),
  ]);

  return {
    hasGitHub: githubResult.length > 0,
    hasEnvironments: environmentResult.length > 0,
    hasSlack: slackResult.length > 0,
    hasLinear: linearResult.length > 0,
    setupCompletedAt: orgResult[0]?.setupCompletedAt ?? null,
    setupNewState: normalizeSetupNewState(orgResult[0]?.setupNewState),
  };
}

export async function ensureDefaultSetupAgents(
  auth: UserAuthSuccess,
): Promise<[]> {
  assertAdmin(auth);
  return [];
}
