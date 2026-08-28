import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
  slackInstallations,
} from '@roomote/db/server';
import {
  BRAIN_SOURCES,
  isMcpConnectionGranolaConfig,
  isMcpConnectionNotionConfig,
  isMcpConnectionRipplingConfig,
  type BrainSourceRequirement,
  type McpConnectionAuthConfig,
  type McpConnectionGranolaConfig,
  type McpConnectionNotionConfig,
  type McpConnectionRipplingConfig,
} from '@roomote/types';

import { hasBrainGithubSources } from './brain-github';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from './mcp/linear-connections';

type BrainMcpSourceId = 'granola' | 'notion' | 'rippling';
type BrainMcpSourceConfig =
  | McpConnectionGranolaConfig
  | McpConnectionNotionConfig
  | McpConnectionRipplingConfig;

const BRAIN_MCP_SOURCE_POLICIES = {
  granola: {
    requiresDeploymentEnablement: false,
    isConfig: isMcpConnectionGranolaConfig,
  },
  notion: {
    requiresDeploymentEnablement: true,
    isConfig: isMcpConnectionNotionConfig,
  },
  rippling: {
    requiresDeploymentEnablement: true,
    isConfig: isMcpConnectionRipplingConfig,
  },
} satisfies Record<
  BrainMcpSourceId,
  {
    requiresDeploymentEnablement: boolean;
    isConfig: (
      value: McpConnectionAuthConfig | null | undefined,
    ) => value is BrainMcpSourceConfig;
  }
>;

export function findBrainSourceConnectionConfig(
  source: 'granola',
): Promise<McpConnectionGranolaConfig | null>;
export function findBrainSourceConnectionConfig(
  source: 'notion',
): Promise<McpConnectionNotionConfig | null>;
export function findBrainSourceConnectionConfig(
  source: 'rippling',
): Promise<McpConnectionRipplingConfig | null>;
export async function findBrainSourceConnectionConfig(
  source: BrainMcpSourceId,
): Promise<BrainMcpSourceConfig | null> {
  const policy = BRAIN_MCP_SOURCE_POLICIES[source];
  const [connection, enablement] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, source),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    }),
    policy.requiresDeploymentEnablement
      ? db.query.deploymentMcpEnablements.findFirst({
          columns: { mcpId: true },
          where: and(
            eq(deploymentMcpEnablements.mcpId, source),
            eq(deploymentMcpEnablements.enabled, true),
          ),
        })
      : Promise.resolve({ mcpId: source }),
  ]);

  return enablement && policy.isConfig(connection?.authConfig)
    ? connection.authConfig
    : null;
}

const BRAIN_SOURCE_AVAILABILITY = {
  slack: async () => {
    const installation = await db.query.slackInstallations.findFirst({
      columns: { id: true },
      where: eq(slackInstallations.isActive, true),
    });
    return Boolean(installation);
  },
  notion: async () => Boolean(await findBrainSourceConnectionConfig('notion')),
  granola: async () =>
    Boolean(await findBrainSourceConnectionConfig('granola')),
  github: hasBrainGithubSources,
  linear: async () => {
    const connection = await findLinearDeploymentMcpConnection();
    return Boolean(
      connection && getLinearDeploymentMetadata(connection.authConfig),
    );
  },
  rippling: async () =>
    Boolean(await findBrainSourceConnectionConfig('rippling')),
} satisfies Record<BrainSourceRequirement, () => Promise<boolean>>;

export function isBrainSourceAvailable(
  requirement: BrainSourceRequirement,
): Promise<boolean> {
  return BRAIN_SOURCE_AVAILABILITY[requirement]();
}

export async function resolveBrainSourceRequirements(
  resolveRequirement: (
    requirement: BrainSourceRequirement,
  ) => Promise<boolean> = isBrainSourceAvailable,
): Promise<Record<BrainSourceRequirement, boolean>> {
  const requirements = [
    ...new Set(
      BRAIN_SOURCES.flatMap((source) =>
        source.requires ? [source.requires] : [],
      ),
    ),
  ];
  const resolved = await Promise.all(
    requirements.map(
      async (requirement) =>
        [requirement, await resolveRequirement(requirement)] as const,
    ),
  );

  return Object.fromEntries(resolved) as Record<
    BrainSourceRequirement,
    boolean
  >;
}
