import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionGrafanaConfig } from '@roomote/types';
import { z } from 'zod';

import { GRAFANA_READ_ONLY_TOOL_NAMES } from '../integration-mcp-policy';
import { toMcpToolResult } from '../proxy-utils';
import { grafanaApiGetJson } from './api';

const TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const GRAFANA_ALLOWED_TOOL_NAMES = new Set<string>(
  GRAFANA_READ_ONLY_TOOL_NAMES,
);

type GrafanaSearchResult = {
  id?: number;
  uid?: string;
  title?: string;
  uri?: string;
  url?: string;
  type?: string;
  tags?: string[];
  isStarred?: boolean;
  folderId?: number;
  folderUid?: string;
  folderTitle?: string;
};

type GrafanaDashboardResponse = {
  dashboard?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type GrafanaAlertRule = Record<string, unknown> & {
  uid?: string;
  title?: string;
  ruleGroup?: string;
  folderUID?: string;
};

type GrafanaDataSource = {
  id?: number;
  uid?: string;
  name?: string;
  type?: string;
  access?: string;
  url?: string;
  database?: string;
  isDefault?: boolean;
  readOnly?: boolean;
  jsonData?: Record<string, unknown>;
};

type GrafanaAnnotation = {
  id?: number;
  alertId?: number;
  dashboardId?: number;
  dashboardUID?: string;
  panelId?: number;
  time?: number;
  timeEnd?: number;
  text?: string;
  type?: string;
  tags?: string[];
  userName?: string;
  login?: string;
  email?: string;
};

type GrafanaAlertInstance = {
  annotations?: Record<string, string>;
  endsAt?: string;
  fingerprint?: string;
  generatorURL?: string;
  labels?: Record<string, string>;
  receivers?: Array<{ name?: string }>;
  startsAt?: string;
  status?: {
    state?: string;
    silencedBy?: string[];
    inhibitedBy?: string[];
  };
  updatedAt?: string;
};

const searchDashboardsInputSchema = {
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional free-text search query.'),
  folder_uids: z
    .array(z.string().min(1))
    .optional()
    .describe('Optional folder UIDs to constrain the search.'),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Optional dashboard tags that must match.'),
  starred: z
    .boolean()
    .optional()
    .describe('Optional filter for starred dashboards.'),
  page: z
    .number()
    .int()
    .refine((value) => value > 0, {
      message: 'Page number must be positive.',
    })
    .optional()
    .describe('Optional positive search result page number.'),
  limit: z
    .number()
    .int()
    .refine((value) => value >= 1 && value <= 500, {
      message: 'Limit must be between 1 and 500.',
    })
    .optional()
    .describe('Number of dashboards to return, from 1 to 500.'),
} as const;

const alertRuleFilterInputSchema = {
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional free-text filter applied to alert rule title or uid.'),
  folder_uid: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional Grafana folder UID filter.'),
  rule_group: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional alert rule group filter.'),
  limit: z
    .number()
    .int()
    .refine((value) => value >= 1 && value <= 500, {
      message: 'Limit must be between 1 and 500.',
    })
    .optional()
    .describe(
      'Number of alert rules to return after filtering, from 1 to 500.',
    ),
} as const;

function assertAllowedToolName(name: string) {
  if (!GRAFANA_ALLOWED_TOOL_NAMES.has(name)) {
    throw new Error(
      `Grafana tool ${name} is not declared in the read-only policy`,
    );
  }
}

function simplifyDashboardSearchResult(result: GrafanaSearchResult) {
  return {
    id: result.id ?? null,
    uid: result.uid ?? null,
    title: result.title ?? null,
    type: result.type ?? null,
    uri: result.uri ?? null,
    url: result.url ?? null,
    tags: result.tags ?? [],
    starred: result.isStarred ?? false,
    folderId: result.folderId ?? null,
    folderUid: result.folderUid ?? null,
    folderTitle: result.folderTitle ?? null,
  };
}

function simplifyDataSource(dataSource: GrafanaDataSource) {
  return {
    id: dataSource.id ?? null,
    uid: dataSource.uid ?? null,
    name: dataSource.name ?? null,
    type: dataSource.type ?? null,
    access: dataSource.access ?? null,
    url: dataSource.url ?? null,
    database: dataSource.database ?? null,
    isDefault: dataSource.isDefault ?? false,
    readOnly: dataSource.readOnly ?? null,
    jsonData: dataSource.jsonData ?? null,
  };
}

function simplifyAnnotation(annotation: GrafanaAnnotation) {
  return {
    id: annotation.id ?? null,
    alertId: annotation.alertId ?? null,
    dashboardId: annotation.dashboardId ?? null,
    dashboardUid: annotation.dashboardUID ?? null,
    panelId: annotation.panelId ?? null,
    time: annotation.time ?? null,
    timeEnd: annotation.timeEnd ?? null,
    text: annotation.text ?? null,
    type: annotation.type ?? null,
    tags: annotation.tags ?? [],
    author: annotation.userName ?? annotation.login ?? annotation.email ?? null,
  };
}

function simplifyAlertInstance(instance: GrafanaAlertInstance) {
  return {
    fingerprint: instance.fingerprint ?? null,
    startsAt: instance.startsAt ?? null,
    endsAt: instance.endsAt ?? null,
    updatedAt: instance.updatedAt ?? null,
    state: instance.status?.state ?? null,
    silencedBy: instance.status?.silencedBy ?? [],
    inhibitedBy: instance.status?.inhibitedBy ?? [],
    labels: instance.labels ?? {},
    annotations: instance.annotations ?? {},
    receivers:
      instance.receivers
        ?.map((receiver) => receiver.name)
        .filter((name): name is string => Boolean(name)) ?? [],
    generatorURL: instance.generatorURL ?? null,
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

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  throw new Error(
    'Time values must be Unix epoch milliseconds or an ISO 8601 timestamp',
  );
}

function matchesAlertRuleFilters(
  rule: GrafanaAlertRule,
  filters: {
    query?: string;
    folderUid?: string;
    ruleGroup?: string;
  },
) {
  if (filters.folderUid && rule.folderUID !== filters.folderUid) {
    return false;
  }

  if (filters.ruleGroup && rule.ruleGroup !== filters.ruleGroup) {
    return false;
  }

  if (!filters.query) {
    return true;
  }

  const needle = filters.query.toLowerCase();
  return (
    String(rule.title ?? '')
      .toLowerCase()
      .includes(needle) ||
    String(rule.uid ?? '')
      .toLowerCase()
      .includes(needle)
  );
}

function registerListDashboardsTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'list_dashboards';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'List Dashboards',
      description:
        'List Grafana dashboards visible to the configured service account.',
      inputSchema: searchDashboardsInputSchema,
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ folder_uids: folderUids, tags, starred, page, limit }) => {
      const response = await grafanaApiGetJson<GrafanaSearchResult[]>({
        config,
        path: 'api/search',
        query: {
          type: 'dash-db',
          folderUIDs: folderUids,
          tag: tags,
          starred,
          page,
          limit,
        },
      });

      return toMcpToolResult({
        dashboards: response.map(simplifyDashboardSearchResult),
        count: response.length,
      });
    },
  );
}

function registerSearchDashboardsTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'search_dashboards';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'Search Dashboards',
      description:
        'Search Grafana dashboards by title, tag, or folder filters.',
      inputSchema: searchDashboardsInputSchema,
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, folder_uids: folderUids, tags, starred, page, limit }) => {
      const response = await grafanaApiGetJson<GrafanaSearchResult[]>({
        config,
        path: 'api/search',
        query: {
          type: 'dash-db',
          query,
          folderUIDs: folderUids,
          tag: tags,
          starred,
          page,
          limit,
        },
      });

      return toMcpToolResult({
        dashboards: response.map(simplifyDashboardSearchResult),
        count: response.length,
      });
    },
  );
}

function registerGetDashboardTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'get_dashboard';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'Get Dashboard',
      description: 'Fetch a Grafana dashboard by dashboard UID.',
      inputSchema: {
        dashboard_uid: z
          .string()
          .trim()
          .min(1)
          .describe('The Grafana dashboard UID.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ dashboard_uid: dashboardUid }) => {
      const response = await grafanaApiGetJson<GrafanaDashboardResponse>({
        config,
        path: `api/dashboards/uid/${encodeURIComponent(dashboardUid)}`,
      });

      return toMcpToolResult({
        dashboard: response.dashboard ?? null,
        meta: response.meta ?? null,
      });
    },
  );
}

function registerListAlertRulesTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'list_alert_rules';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'List Alert Rules',
      description:
        'List Grafana managed alert rules from the configured workspace.',
      inputSchema: alertRuleFilterInputSchema,
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, folder_uid: folderUid, rule_group: ruleGroup, limit }) => {
      const response = await grafanaApiGetJson<GrafanaAlertRule[]>({
        config,
        path: 'api/v1/provisioning/alert-rules',
      });

      const alertRules = response
        .filter((rule) =>
          matchesAlertRuleFilters(rule, {
            query,
            folderUid,
            ruleGroup,
          }),
        )
        .slice(0, limit ?? response.length);

      return toMcpToolResult({
        alertRules,
        count: alertRules.length,
      });
    },
  );
}

function registerGetAlertRuleTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'get_alert_rule';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'Get Alert Rule',
      description: 'Fetch a Grafana alert rule by alert rule UID.',
      inputSchema: {
        alert_rule_uid: z
          .string()
          .trim()
          .min(1)
          .describe('The Grafana alert rule UID.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ alert_rule_uid: alertRuleUid }) => {
      const alertRule = await grafanaApiGetJson<GrafanaAlertRule>({
        config,
        path: `api/v1/provisioning/alert-rules/${encodeURIComponent(alertRuleUid)}`,
      });

      return toMcpToolResult({ alertRule });
    },
  );
}

function registerListAlertInstancesTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'list_alert_instances';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'List Alert Instances',
      description:
        'List current Grafana alert instances and their runtime state.',
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe('Whether to include active alert instances.'),
        silenced: z
          .boolean()
          .optional()
          .describe('Whether to include silenced alert instances.'),
        inhibited: z
          .boolean()
          .optional()
          .describe('Whether to include inhibited alert instances.'),
        unprocessed: z
          .boolean()
          .optional()
          .describe('Whether to include unprocessed alert instances.'),
        receiver: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional Alertmanager receiver name filter.'),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 500, {
            message: 'Limit must be between 1 and 500.',
          })
          .optional()
          .describe('Number of alert instances to return, from 1 to 500.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ active, silenced, inhibited, unprocessed, receiver, limit }) => {
      const response = await grafanaApiGetJson<GrafanaAlertInstance[]>({
        config,
        path: 'api/alertmanager/grafana/api/v2/alerts',
        query: {
          active,
          silenced,
          inhibited,
          unprocessed,
          receiver,
        },
      });

      const alertInstances = response
        .map(simplifyAlertInstance)
        .slice(0, limit ?? response.length);

      return toMcpToolResult({
        alertInstances,
        count: alertInstances.length,
      });
    },
  );
}

function registerListDataSourcesTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'list_data_sources';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'List Data Sources',
      description:
        'List Grafana data sources visible to the configured service account.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional free-text filter applied to name, uid, or type.'),
        type: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional Grafana data source type filter.'),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 500, {
            message: 'Limit must be between 1 and 500.',
          })
          .optional()
          .describe('Number of data sources to return, from 1 to 500.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, type, limit }) => {
      const response = await grafanaApiGetJson<GrafanaDataSource[]>({
        config,
        path: 'api/datasources',
      });

      const normalizedQuery = query?.toLowerCase();
      const dataSources = response
        .filter((entry) => {
          if (type && entry.type !== type) {
            return false;
          }

          if (!normalizedQuery) {
            return true;
          }

          return [entry.name, entry.uid, entry.type].some((value) =>
            String(value ?? '')
              .toLowerCase()
              .includes(normalizedQuery),
          );
        })
        .map(simplifyDataSource)
        .slice(0, limit ?? response.length);

      return toMcpToolResult({
        dataSources,
        count: dataSources.length,
      });
    },
  );
}

function registerListAnnotationsTool(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  const toolName = 'list_annotations';
  assertAllowedToolName(toolName);

  server.registerTool(
    toolName,
    {
      title: 'List Annotations',
      description:
        'List Grafana annotations for dashboards, panels, and alerts.',
      inputSchema: {
        from: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'Optional start time as Unix epoch milliseconds or ISO 8601.',
          ),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'Optional end time as Unix epoch milliseconds or ISO 8601.',
          ),
        dashboard_uid: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional Grafana dashboard UID filter.'),
        panel_id: z
          .number()
          .int()
          .refine((value) => value >= 0, {
            message: 'Panel ID must be non-negative.',
          })
          .optional()
          .describe('Optional non-negative integer panel ID filter.'),
        alert_id: z
          .number()
          .int()
          .refine((value) => value >= 0, {
            message: 'Alert ID must be non-negative.',
          })
          .optional()
          .describe('Optional non-negative integer alert ID filter.'),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional annotation tags to match.'),
        text_query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional client-side text filter for annotation text.'),
        limit: z
          .number()
          .int()
          .refine((value) => value >= 1 && value <= 500, {
            message: 'Limit must be between 1 and 500.',
          })
          .optional()
          .describe('Number of annotations to return, from 1 to 500.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      from,
      to,
      dashboard_uid: dashboardUid,
      panel_id: panelId,
      alert_id: alertId,
      tags,
      text_query: textQuery,
      limit,
    }) => {
      const response = await grafanaApiGetJson<GrafanaAnnotation[]>({
        config,
        path: 'api/annotations',
        query: {
          from: parseTimeInput(from),
          to: parseTimeInput(to),
          dashboardUID: dashboardUid,
          panelId: panelId,
          alertId: alertId,
          tags,
          limit,
        },
      });

      const normalizedQuery = textQuery?.toLowerCase();
      const annotations = response
        .filter((annotation) => {
          if (!normalizedQuery) {
            return true;
          }

          return String(annotation.text ?? '')
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .map(simplifyAnnotation);

      return toMcpToolResult({
        annotations,
        count: annotations.length,
      });
    },
  );
}

export function registerGrafanaTools(
  server: McpServer,
  config: McpConnectionGrafanaConfig,
) {
  registerListDashboardsTool(server, config);
  registerSearchDashboardsTool(server, config);
  registerGetDashboardTool(server, config);
  registerListAlertRulesTool(server, config);
  registerGetAlertRuleTool(server, config);
  registerListAlertInstancesTool(server, config);
  registerListDataSourcesTool(server, config);
  registerListAnnotationsTool(server, config);
}
