import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionVercelConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult } from '../proxy-utils';

import {
  vercelApiGetJson,
  vercelApiGetStreamJson,
  vercelApiPostJson,
  withResolvedTeamQuery,
} from './api';

const TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const nonEmptyStringSchema = z.string().refine((value) => value.length > 0, {
  message: 'Value must be non-empty.',
});

type VercelTeam = {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  createdAt?: number;
  previewDeploymentSuffix?: string;
  membership?: {
    role?: string;
    confirmed?: boolean;
  };
};

type VercelTeamsResponse = {
  teams?: VercelTeam[];
  pagination?: {
    count?: number;
    next?: number;
    prev?: number;
  };
};

type VercelProject = {
  id: string;
  name: string;
  accountId?: string;
  framework?: string | null;
  createdAt?: number;
  updatedAt?: number;
  directoryListing?: boolean;
  latestDeployments?: VercelDeployment[];
  link?: {
    type?: string;
    repo?: string;
    productionBranch?: string;
  };
  targets?: Record<string, unknown>;
  protectionBypass?: Record<string, unknown>;
  alias?: Array<{
    domain?: string;
    target?: string;
    environment?: string;
  }>;
};

type VercelProjectsResponse = {
  projects?: VercelProject[];
  pagination?: {
    count?: number;
    next?: number;
    prev?: number;
  };
};

type VercelDeployment = {
  uid?: string;
  id?: string;
  name?: string;
  projectId?: string;
  url?: string | null;
  created?: number;
  createdAt?: number;
  state?: string;
  readyState?: string;
  readySubstate?: string;
  target?: string;
  source?: string;
  inspectorUrl?: string;
  alias?: string[];
  errorMessage?: string | null;
  errorCode?: string | null;
  creator?: {
    uid?: string;
    email?: string;
    username?: string;
  };
  projectSettings?: {
    framework?: string | null;
    nodeVersion?: string | null;
  };
};

type VercelDeploymentsResponse = {
  deployments?: VercelDeployment[];
  pagination?: {
    count?: number;
    next?: number;
    prev?: number;
  };
};

type VercelDeploymentEvent = {
  type: string;
  created: number;
  payload?: {
    text?: string;
    statusCode?: number;
    requestId?: string;
    info?: {
      name?: string;
      path?: string;
      type?: string;
      step?: string;
      readyState?: string;
    };
    proxy?: {
      timestamp?: number;
      method?: string;
      host?: string;
      path?: string;
      statusCode?: number;
      region?: string;
      lambdaRegion?: string;
      vercelCache?: string;
    };
  };
};

type VercelRuntimeLog = {
  level: 'error' | 'warning' | 'info';
  message: string;
  rowId: string;
  source:
    | 'delimiter'
    | 'edge-function'
    | 'edge-middleware'
    | 'serverless'
    | 'request';
  timestampInMs: number;
  domain: string;
  messageTruncated: boolean;
  requestMethod?: string;
  requestPath?: string;
  responseStatusCode?: number;
};

type VercelDomainAvailabilityResponse = {
  available: boolean;
};

type VercelDomainPriceResponse = {
  years: number;
  purchasePrice: number;
  renewalPrice: number;
  transferPrice: number;
};

const optionalTeamIdSchema = z
  .string()
  .trim()
  .optional()
  .describe(
    'Optional Vercel team ID or slug. Uses the saved default team when omitted.',
  );

function simplifyTeam(team: VercelTeam) {
  return {
    id: team.id,
    slug: team.slug ?? null,
    name: team.name,
    description: team.description ?? null,
    createdAt: team.createdAt ?? null,
    previewDeploymentSuffix: team.previewDeploymentSuffix ?? null,
    membership: team.membership
      ? {
          role: team.membership.role ?? null,
          confirmed: team.membership.confirmed ?? null,
        }
      : null,
  };
}

function simplifyDeployment(deployment: VercelDeployment) {
  return {
    id: deployment.uid ?? deployment.id ?? null,
    name: deployment.name ?? null,
    projectId: deployment.projectId ?? null,
    url: deployment.url ?? null,
    createdAt: deployment.createdAt ?? deployment.created ?? null,
    state: deployment.state ?? deployment.readyState ?? null,
    readyState: deployment.readyState ?? null,
    readySubstate: deployment.readySubstate ?? null,
    target: deployment.target ?? null,
    source: deployment.source ?? null,
    inspectorUrl: deployment.inspectorUrl ?? null,
    alias: deployment.alias ?? [],
    errorCode: deployment.errorCode ?? null,
    errorMessage: deployment.errorMessage ?? null,
    creator: deployment.creator
      ? {
          uid: deployment.creator.uid ?? null,
          email: deployment.creator.email ?? null,
          username: deployment.creator.username ?? null,
        }
      : null,
    projectSettings: deployment.projectSettings
      ? {
          framework: deployment.projectSettings.framework ?? null,
          nodeVersion: deployment.projectSettings.nodeVersion ?? null,
        }
      : null,
  };
}

function simplifyProject(project: VercelProject) {
  return {
    id: project.id,
    name: project.name,
    accountId: project.accountId ?? null,
    framework: project.framework ?? null,
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
    directoryListing: project.directoryListing ?? null,
    alias:
      project.alias?.map((entry) => ({
        domain: entry.domain ?? null,
        target: entry.target ?? null,
        environment: entry.environment ?? null,
      })) ?? [],
    latestDeployments:
      project.latestDeployments?.map((deployment) =>
        simplifyDeployment(deployment),
      ) ?? [],
    gitLink: project.link
      ? {
          type: project.link.type ?? null,
          repo: project.link.repo ?? null,
          productionBranch: project.link.productionBranch ?? null,
        }
      : null,
    protectionBypassConfigured:
      project.protectionBypass != null &&
      Object.keys(project.protectionBypass).length > 0,
  };
}

function simplifyBuildEvent(event: VercelDeploymentEvent) {
  return {
    type: event.type,
    created: event.created,
    text: event.payload?.text ?? null,
    buildId: event.payload?.info?.name ?? null,
    step: event.payload?.info?.step ?? null,
    path: event.payload?.info?.path ?? null,
    requestId: event.payload?.requestId ?? null,
    statusCode:
      event.payload?.statusCode ?? event.payload?.proxy?.statusCode ?? null,
    host: event.payload?.proxy?.host ?? null,
    method: event.payload?.proxy?.method ?? null,
    requestPath: event.payload?.proxy?.path ?? null,
    region: event.payload?.proxy?.region ?? null,
    lambdaRegion: event.payload?.proxy?.lambdaRegion ?? null,
  };
}

function parseTimeInput(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed);
  }

  const durationMatch = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)$/iu);
  if (durationMatch) {
    const [, rawAmount = '0', rawUnit = 'ms'] = durationMatch;
    const amount = Number(rawAmount);
    const unit = rawUnit.toLowerCase();
    const multiplier =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1_000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : 86_400_000;

    return Date.now() - amount * multiplier;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchesStatusCode(
  actualStatusCode: number | undefined,
  filter: string | undefined,
) {
  if (!filter) {
    return true;
  }

  if (actualStatusCode === undefined) {
    return false;
  }

  const trimmed = filter.trim();
  if (/^\d{3}$/u.test(trimmed)) {
    return actualStatusCode === Number(trimmed);
  }

  const rangeMatch = trimmed.match(/^(\d)xx$/iu);
  if (rangeMatch) {
    return String(actualStatusCode).startsWith(rangeMatch[1] ?? '');
  }

  return true;
}

function matchesRuntimeQuery(log: VercelRuntimeLog, query: string | undefined) {
  if (!query) {
    return true;
  }

  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    log.message,
    log.domain,
    log.requestMethod,
    log.requestPath,
    log.rowId,
  ]
    .filter(Boolean)
    .some((value) => value?.toLowerCase().includes(needle));
}

async function resolveProjectIdForDeployment(params: {
  config: McpConnectionVercelConfig;
  deploymentId: string;
  teamIdOrSlug?: string;
}): Promise<string | null> {
  const deployment = await vercelApiGetJson<VercelDeployment>({
    config: params.config,
    path: `v13/deployments/${encodeURIComponent(params.deploymentId)}`,
    query: withResolvedTeamQuery(params.config, params.teamIdOrSlug),
  });

  return deployment.projectId ?? null;
}

async function getRuntimeLogsForDeployment(params: {
  config: McpConnectionVercelConfig;
  projectId: string;
  deploymentId: string;
  teamIdOrSlug?: string;
}): Promise<VercelRuntimeLog[]> {
  return vercelApiGetStreamJson<VercelRuntimeLog>({
    config: params.config,
    path: `v1/projects/${encodeURIComponent(params.projectId)}/deployments/${encodeURIComponent(params.deploymentId)}/runtime-logs`,
    query: withResolvedTeamQuery(params.config, params.teamIdOrSlug),
  });
}

function registerListTeamsTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'list_teams',
    {
      title: 'List Teams',
      description:
        'List Vercel teams that the configured access token can inspect.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 100, {
            message: 'Limit must be between 1 and 100.',
          })
          .optional()
          .describe('Optional page size from 1 to 100.'),
        since: z
          .number()
          .int()
          .optional()
          .describe(
            'Only return teams created since this Unix timestamp in milliseconds.',
          ),
        until: z
          .number()
          .int()
          .optional()
          .describe(
            'Only return teams created until this Unix timestamp in milliseconds.',
          ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ limit, since, until }) => {
      const response = await vercelApiGetJson<VercelTeamsResponse>({
        config,
        path: 'v2/teams',
        query: { limit, since, until },
      });

      return toMcpToolResult({
        teams: (response.teams ?? []).map((team) => simplifyTeam(team)),
        pagination: response.pagination ?? null,
      });
    },
  );
}

function registerListProjectsTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'list_projects',
    {
      title: 'List Projects',
      description:
        'List Vercel projects for a team or the token owner account.',
      inputSchema: {
        teamId: optionalTeamIdSchema,
        search: z
          .string()
          .trim()
          .optional()
          .describe('Optional search string to filter projects by name.'),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 100, {
            message: 'Limit must be between 1 and 100.',
          })
          .optional()
          .describe('Optional page size from 1 to 100.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ teamId, search, limit }) => {
      const response = await vercelApiGetJson<VercelProjectsResponse>({
        config,
        path: 'v9/projects',
        query: withResolvedTeamQuery(config, teamId, {
          search: search || undefined,
          limit,
        }),
      });

      return toMcpToolResult({
        projects: (response.projects ?? []).map((project) =>
          simplifyProject(project),
        ),
        pagination: response.pagination ?? null,
      });
    },
  );
}

function registerGetProjectTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'get_project',
    {
      title: 'Get Project',
      description:
        'Fetch detailed Vercel project information including domains and latest deployments.',
      inputSchema: {
        projectId: nonEmptyStringSchema.describe(
          'The non-empty Vercel project ID or project slug.',
        ),
        teamId: optionalTeamIdSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ projectId, teamId }) => {
      const response = await vercelApiGetJson<VercelProject>({
        config,
        path: `v9/projects/${encodeURIComponent(projectId)}`,
        query: withResolvedTeamQuery(config, teamId),
      });

      return toMcpToolResult({
        project: simplifyProject(response),
      });
    },
  );
}

function registerListDeploymentsTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'list_deployments',
    {
      title: 'List Deployments',
      description:
        'List Vercel deployments for a project with state, target, and timing metadata.',
      inputSchema: {
        projectId: nonEmptyStringSchema.describe(
          'The non-empty Vercel project ID.',
        ),
        teamId: optionalTeamIdSchema,
        since: z
          .number()
          .int()
          .optional()
          .describe(
            'Only return deployments created after this Unix timestamp in milliseconds.',
          ),
        until: z
          .number()
          .int()
          .optional()
          .describe(
            'Only return deployments created before this Unix timestamp in milliseconds.',
          ),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 100, {
            message: 'Limit must be between 1 and 100.',
          })
          .optional()
          .describe('Number of deployments to return, from 1 to 100.'),
        target: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional deployment target, for example production or preview.',
          ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ projectId, teamId, since, until, limit, target }) => {
      const response = await vercelApiGetJson<VercelDeploymentsResponse>({
        config,
        path: 'v6/deployments',
        query: withResolvedTeamQuery(config, teamId, {
          projectId,
          since,
          until,
          limit,
          target: target || undefined,
        }),
      });

      return toMcpToolResult({
        deployments: (response.deployments ?? []).map((deployment) =>
          simplifyDeployment(deployment),
        ),
        pagination: response.pagination ?? null,
      });
    },
  );
}

function registerGetDeploymentTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'get_deployment',
    {
      title: 'Get Deployment',
      description:
        'Fetch detailed information for a deployment by deployment ID or hostname.',
      inputSchema: {
        idOrUrl: nonEmptyStringSchema.describe(
          'The non-empty Vercel deployment ID or hostname.',
        ),
        teamId: optionalTeamIdSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ idOrUrl, teamId }) => {
      const response = await vercelApiGetJson<VercelDeployment>({
        config,
        path: `v13/deployments/${encodeURIComponent(idOrUrl)}`,
        query: withResolvedTeamQuery(config, teamId),
      });

      return toMcpToolResult({
        deployment: simplifyDeployment(response),
      });
    },
  );
}

function registerGetDeploymentBuildLogsTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'get_deployment_build_logs',
    {
      title: 'Get Deployment Build Logs',
      description:
        'Get build log events for a deployment by deployment ID or hostname.',
      inputSchema: {
        idOrUrl: nonEmptyStringSchema.describe(
          'The non-empty Vercel deployment ID or hostname.',
        ),
        teamId: optionalTeamIdSchema,
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 500, {
            message: 'Limit must be between 1 and 500.',
          })
          .optional()
          .describe('Number of build events to return, from 1 to 500.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ idOrUrl, teamId, limit }) => {
      const response = await vercelApiGetStreamJson<VercelDeploymentEvent>({
        config,
        path: `v3/deployments/${encodeURIComponent(idOrUrl)}/events`,
        query: withResolvedTeamQuery(config, teamId, {
          builds: 1,
          direction: 'backward',
          limit: limit ?? 100,
        }),
      });

      return toMcpToolResult({
        events: response.map((event) => simplifyBuildEvent(event)),
      });
    },
  );
}

function registerGetRuntimeLogsTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'get_runtime_logs',
    {
      title: 'Get Runtime Logs',
      description:
        'Get runtime logs for a deployment, or for the single latest matching deployment in a project.',
      inputSchema: {
        projectId: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional Vercel project ID. Required when deploymentId is omitted.',
          ),
        deploymentId: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional deployment ID. When omitted, Roomote inspects only the latest matching deployment for the project.',
          ),
        teamId: optionalTeamIdSchema,
        target: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional deployment target filter such as production or preview.',
          ),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 500, {
            message: 'Limit must be between 1 and 500.',
          })
          .optional()
          .describe('Number of runtime log rows to return, from 1 to 500.'),
        since: z
          .union([z.number().int(), z.string().trim()])
          .optional()
          .describe(
            'Optional lower time bound as Unix milliseconds, ISO timestamp, or relative value like 1h.',
          ),
        until: z
          .union([z.number().int(), z.string().trim()])
          .optional()
          .describe(
            'Optional upper time bound as Unix milliseconds or ISO timestamp.',
          ),
        level: z
          .enum(['error', 'warning', 'info'])
          .optional()
          .describe('Optional log level filter.'),
        source: z
          .enum([
            'delimiter',
            'edge-function',
            'edge-middleware',
            'serverless',
            'request',
          ])
          .optional()
          .describe('Optional log source filter.'),
        statusCode: z
          .string()
          .trim()
          .optional()
          .describe('Optional status code filter such as 404 or 5xx.'),
        requestId: z
          .string()
          .trim()
          .optional()
          .describe('Optional exact request ID filter.'),
        query: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional full-text filter across message, domain, and request path.',
          ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      projectId,
      deploymentId,
      teamId,
      target,
      limit,
      since,
      until,
      level,
      source,
      statusCode,
      requestId,
      query,
    }) => {
      const resolvedProjectId = projectId?.trim().length
        ? projectId.trim()
        : deploymentId?.trim().length
          ? await resolveProjectIdForDeployment({
              config,
              deploymentId: deploymentId.trim(),
              teamIdOrSlug: teamId,
            })
          : null;

      if (!resolvedProjectId) {
        throw new Error(
          'projectId is required when deploymentId is not provided.',
        );
      }

      let resolvedDeploymentId: string | null = null;

      if (deploymentId?.trim()) {
        resolvedDeploymentId = deploymentId.trim();
      } else {
        const deploymentResponse =
          await vercelApiGetJson<VercelDeploymentsResponse>({
            config,
            path: 'v6/deployments',
            query: withResolvedTeamQuery(config, teamId, {
              projectId: resolvedProjectId,
              since: parseTimeInput(since),
              until: parseTimeInput(until),
              target: target || undefined,
              limit: 1,
            }),
          });

        const latestDeployment = deploymentResponse.deployments?.find(
          (deployment) => deployment.uid || deployment.id,
        );
        if (latestDeployment) {
          resolvedDeploymentId =
            latestDeployment.uid ?? latestDeployment.id ?? null;
        }
      }

      if (!resolvedDeploymentId) {
        return toMcpToolResult({
          logs: [],
        });
      }

      const sinceMs = parseTimeInput(since);
      const untilMs = parseTimeInput(until);
      const maxResults = limit ?? 100;
      const logs: Array<
        VercelRuntimeLog & { deploymentId: string; projectId: string }
      > = [];

      const runtimeLogs = await getRuntimeLogsForDeployment({
        config,
        projectId: resolvedProjectId,
        deploymentId: resolvedDeploymentId,
        teamIdOrSlug: teamId,
      });

      for (const log of runtimeLogs) {
        if (logs.length >= maxResults) {
          break;
        }

        if (sinceMs !== undefined && log.timestampInMs < sinceMs) {
          continue;
        }

        if (untilMs !== undefined && log.timestampInMs > untilMs) {
          continue;
        }

        if (level && log.level !== level) {
          continue;
        }

        if (source && log.source !== source) {
          continue;
        }

        if (
          requestId &&
          log.rowId !== requestId &&
          !log.message.includes(requestId)
        ) {
          continue;
        }

        if (!matchesStatusCode(log.responseStatusCode, statusCode)) {
          continue;
        }

        if (!matchesRuntimeQuery(log, query)) {
          continue;
        }

        logs.push({
          ...log,
          deploymentId: resolvedDeploymentId,
          projectId: resolvedProjectId,
        });
      }

      logs.sort((left, right) => right.timestampInMs - left.timestampInMs);

      return toMcpToolResult({
        logs: logs.slice(0, maxResults),
      });
    },
  );
}

function registerCheckDomainAvailabilityAndPriceTool(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  server.registerTool(
    'check_domain_availability_and_price',
    {
      title: 'Check Domain Availability And Price',
      description:
        'Check whether domains are available and fetch purchase pricing for available names.',
      inputSchema: {
        names: z
          .array(z.string().trim())
          .refine(
            (names) =>
              names.length >= 1 &&
              names.length <= 50 &&
              names.every((name) => name.length > 0),
            {
              message: 'Provide 1 to 50 non-empty domain names.',
            },
          )
          .describe('From 1 to 50 non-empty domain names to inspect.'),
        teamId: optionalTeamIdSchema,
        years: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 10, {
            message: 'Years must be between 1 and 10.',
          })
          .optional()
          .describe(
            'Optional number of years to quote for the purchase price, from 1 to 10.',
          ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ names, teamId, years }) => {
      const availabilityResponse = await vercelApiPostJson<{
        results?: Array<{ domain: string; available: boolean }>;
      }>({
        config,
        path: 'v1/registrar/domains/availability',
        query: withResolvedTeamQuery(config, teamId),
        body: {
          domains: names,
        },
      });

      const availabilityByDomain = new Map(
        (availabilityResponse.results ?? []).map((result) => [
          result.domain,
          result.available,
        ]),
      );

      const results = await Promise.all(
        names.map(async (name) => {
          let available = availabilityByDomain.get(name) ?? false;

          let pricing: VercelDomainPriceResponse | null = null;
          if (available) {
            pricing = await vercelApiGetJson<VercelDomainPriceResponse>({
              config,
              path: `v1/registrar/domains/${encodeURIComponent(name)}/price`,
              query: withResolvedTeamQuery(config, teamId, {
                years,
              }),
            });
          } else {
            const availability =
              await vercelApiGetJson<VercelDomainAvailabilityResponse>({
                config,
                path: `v1/registrar/domains/${encodeURIComponent(name)}/availability`,
                query: withResolvedTeamQuery(config, teamId),
              });

            available = availability.available;
            if (availability.available) {
              pricing = await vercelApiGetJson<VercelDomainPriceResponse>({
                config,
                path: `v1/registrar/domains/${encodeURIComponent(name)}/price`,
                query: withResolvedTeamQuery(config, teamId, {
                  years,
                }),
              });
            }
          }

          return {
            domain: name,
            available,
            pricing:
              pricing != null
                ? {
                    years: pricing.years,
                    purchasePrice: pricing.purchasePrice,
                    renewalPrice: pricing.renewalPrice,
                    transferPrice: pricing.transferPrice,
                  }
                : null,
          };
        }),
      );

      return toMcpToolResult({ results });
    },
  );
}

export function registerVercelTools(
  server: McpServer,
  config: McpConnectionVercelConfig,
) {
  registerListTeamsTool(server, config);
  registerListProjectsTool(server, config);
  registerGetProjectTool(server, config);
  registerListDeploymentsTool(server, config);
  registerGetDeploymentTool(server, config);
  registerGetDeploymentBuildLogsTool(server, config);
  registerGetRuntimeLogsTool(server, config);
  registerCheckDomainAvailabilityAndPriceTool(server, config);
}
