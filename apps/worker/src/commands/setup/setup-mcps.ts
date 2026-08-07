import * as path from 'node:path';

import {
  CUSTOM_MCP_PROXY_PATH_PREFIX,
  getMcpIntegrationUpstreamUrl,
  isReservedRuntimeMcpEnvVarName,
  isRoomoteNamespacedEnvVarName,
  MCP_INTEGRATIONS,
  REFUSED_ENV_REFERENCE_PLACEHOLDER,
  type EnvironmentMcpServers,
} from '@roomote/types';

import {
  collectEnvVarReferences,
  redactEnvVarReferences,
  substituteEnvVars,
} from '../../env';

// The Roomote MCP server is compiled into the worker's dist directory.
// Resolve its path relative to the running worker script (process.argv[1]).
const roomoteMcpPath = process.argv[1]
  ? path.join(
      path.dirname(path.resolve(process.argv[1])),
      'mcp/roomote-mcp-server/index.js',
    )
  : path.join(
      process.env.HOME || '/home/roomote',
      'worker/dist/mcp/roomote-mcp-server/index.js',
    );

/**
 * Built-in MCP servers enabled for all cloud agents.
 * Add entries here to make them available to the active OpenCode runtime.
 */
export const BUILT_IN_MCPS: Record<string, McpServerConfig> = {
  roomote: {
    type: 'stdio',
    command: 'node',
    args: [roomoteMcpPath],
  },
};

interface McpStreamableHttpConfig {
  type: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

interface McpStdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpServerConfig = McpStreamableHttpConfig | McpStdioConfig;

interface UserMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

interface IntegrationProxyConfig {
  id: string;
  name: string;
  proxyPath: string;
  upstreamOrigin?: string;
  upstreamPath?: string;
}

/**
 * Build the ${...} substitution lookup for custom MCP config: the task env
 * minus reserved runtime names, overlaid with operator-defined deployment
 * vars. Operator values win on collision, so an operator var that happens to
 * share a generic reserved name (for example their own DATABASE_URL)
 * resolves to the operator's value — never to a Roomote-internal one.
 * Roomote-namespaced names are dropped even from the operator overlay as
 * defense in depth against runtime-injected entries.
 */
function buildMcpSubstitutionLookup(
  taskEnv: Record<string, string> | undefined,
  operatorEnvVars: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(taskEnv ?? {}).filter(
        ([name]) => !isReservedRuntimeMcpEnvVarName(name),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(operatorEnvVars ?? {}).filter(
        ([name]) => !isRoomoteNamespacedEnvVarName(name),
      ),
    ),
  };
}

/**
 * Warn about `${VAR}` references that will not be substituted, so a refused
 * or misspelled reference fails loudly instead of reaching the MCP server as
 * a literal `${VAR}` string with no trace anywhere.
 */
function warnUnresolvableConfigReferences(options: {
  serverName: string;
  field: 'env' | 'headers';
  values: Record<string, string>;
  lookup: Record<string, string>;
}): void {
  const warnedNames = new Set<string>();

  for (const value of Object.values(options.values)) {
    for (const name of collectEnvVarReferences(value)) {
      if (warnedNames.has(name) || name in options.lookup) {
        continue;
      }

      warnedNames.add(name);

      if (isReservedRuntimeMcpEnvVarName(name)) {
        console.warn(
          `[resolveBuiltInMcpServers] Custom MCP '${options.serverName}' ${options.field}: ` +
            `\${${name}} was NOT substituted because the name is a reserved ` +
            `Roomote runtime name. Define your own deployment environment ` +
            `variable under a different name and reference that instead; ` +
            `the reference was replaced with ` +
            `'${REFUSED_ENV_REFERENCE_PLACEHOLDER}'.`,
        );
      } else {
        console.warn(
          `[resolveBuiltInMcpServers] Custom MCP '${options.serverName}' ${options.field}: ` +
            `\${${name}} is not defined in the task environment; the literal ` +
            `reference was passed through unchanged.`,
        );
      }
    }
  }
}

function resolveConfigValues(
  values: Record<string, string> | undefined,
  lookup: Record<string, string>,
  context: { serverName: string; field: 'env' | 'headers' },
): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }

  warnUnresolvableConfigReferences({
    serverName: context.serverName,
    field: context.field,
    values,
    lookup,
  });

  // Neutralize refused references before substituting. A reserved name that
  // is merely left unsubstituted survives as literal `${VAR}` text, which the
  // OpenCode bootstrap then rewrites into a live `{env:VAR}` reference --
  // turning this refusal back into a working read of the runtime env. Names
  // the operator legitimately shadows are already in `lookup` and substitute
  // normally, so they never reach the redaction below.
  const redacted = redactEnvVarReferences(
    values,
    (name) => !(name in lookup) && isReservedRuntimeMcpEnvVarName(name),
    REFUSED_ENV_REFERENCE_PLACEHOLDER,
  );

  return substituteEnvVars(redacted, lookup);
}

function buildIntegrationProxyMap(): Map<string, IntegrationProxyConfig> {
  const integrationConfigs: IntegrationProxyConfig[] = [];

  for (const integration of MCP_INTEGRATIONS) {
    const upstreamUrl = getMcpIntegrationUpstreamUrl(integration);
    const upstream = upstreamUrl ? parseUrl(upstreamUrl) : null;

    integrationConfigs.push({
      id: integration.id,
      name: integration.name,
      proxyPath: `/api/mcp/${integration.id}`,
      ...(upstream
        ? {
            upstreamOrigin: upstream.origin,
            upstreamPath: upstream.pathname,
          }
        : {}),
    });
  }

  return new Map(
    integrationConfigs.map((integration) => [integration.id, integration]),
  );
}

const INTEGRATION_PROXY_MAP = buildIntegrationProxyMap();

/**
 * Integration MCP toggles fetched at runtime from the org's connected services.
 * When enabled, a corresponding MCP server is added to the agent's config.
 */
export interface IntegrationMcpOptions {
  /** OAuth-backed integration MCP servers available to the current task actor. */
  userMcpServers?: Record<string, UserMcpServerConfig>;
}

function normalizeApiBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, '');
}

function resolveApiBaseUrl(
  taskEnv: Record<string, string> | undefined,
): string | undefined {
  // Prefer TRPC_URL (API origin) when available. R_APP_URL may point
  // at the web app domain in some environments.
  return (
    normalizeApiBaseUrl(process.env.TRPC_URL) ??
    normalizeApiBaseUrl(taskEnv?.R_APP_URL)
  );
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Returns the `/api/mcp/custom/<id>` path when the URL is a deployment
 * custom-server proxy entry (path-only or absolute), else null.
 */
function parseCustomMcpProxyPath(url: string): string | null {
  if (url.startsWith(CUSTOM_MCP_PROXY_PATH_PREFIX)) {
    return url;
  }

  const parsed = parseUrl(url);

  if (parsed?.pathname.startsWith(CUSTOM_MCP_PROXY_PATH_PREFIX)) {
    return parsed.pathname;
  }

  return null;
}

function isExpectedProxyUrl(url: string, proxyPath: string): boolean {
  if (url === proxyPath) {
    return true;
  }

  const parsed = parseUrl(url);
  return parsed?.pathname === proxyPath;
}

function isRawUpstreamUrl(
  url: string,
  upstreamOrigin: string,
  upstreamPath: string,
): boolean {
  const parsed = parseUrl(url);

  if (!parsed) {
    return false;
  }

  return parsed.origin === upstreamOrigin && parsed.pathname === upstreamPath;
}

function withTaskRunTokenAuthHeader(
  headers: Record<string, string> | undefined,
  cloudToken: string,
): Record<string, string> {
  const rewrittenHeaders = { ...(headers ?? {}) };

  for (const headerName of Object.keys(rewrittenHeaders)) {
    if (headerName.toLowerCase() === 'authorization') {
      delete rewrittenHeaders[headerName];
    }
  }

  rewrittenHeaders.Authorization = `Bearer ${cloudToken}`;
  return rewrittenHeaders;
}

function withPreviewProxyBypassHeader(
  headers: Record<string, string>,
  taskEnv: Record<string, string> | undefined,
): Record<string, string> {
  const bypassHeaderName = taskEnv?.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
  const bypassHeaderValue = taskEnv?.ROOMOTE_AUTH_BYPASS_VALUE;

  if (!bypassHeaderName || !bypassHeaderValue) {
    return headers;
  }

  return {
    ...headers,
    [bypassHeaderName]: bypassHeaderValue,
  };
}

/**
 * Resolve the full MCP server map for the current task/setup context.
 * This applies stdio env injection and optional integration-provided MCPs.
 */
export function resolveBuiltInMcpServers(
  taskEnv?: Record<string, string>,
  integrations?: IntegrationMcpOptions,
  environmentMcpServers?: EnvironmentMcpServers,
  operatorEnvVars?: Record<string, string>,
  deploymentMcpServers?: EnvironmentMcpServers,
): Record<string, McpServerConfig> {
  // The extension's StdioClientTransport only inherits a minimal set of
  // env vars (HOME, PATH, SHELL, TERM, USER) via getDefaultEnvironment().
  // Mise shims (npx, node) need MISE_DATA_DIR to locate runtimes, so we
  // inject it into each stdio config's env field.
  const stdioEnvExtras: Record<string, string> = {};

  for (const key of ['MISE_DATA_DIR', 'MISE_CACHE_DIR']) {
    if (process.env[key]) {
      stdioEnvExtras[key] = process.env[key]!;
    }
  }

  // Task-specific env vars for the Roomote MCP server.
  // These are only available when called from runTask() with taskEnv.
  const roomoteEnvKeys = [
    'ROOMOTE_CLOUD_TOKEN',
    'R_APP_URL',
    'ROOMOTE_PLATFORM_API_URL',
    'ROOMOTE_WORKSPACE_PATH',
    'ROOMOTE_TASK_ID',
    'ROOMOTE_AUTH_BYPASS_HEADER_NAME',
    'ROOMOTE_AUTH_BYPASS_VALUE',
    'ROOMOTE_TASK_TYPE',
    'ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE',
    'ROOMOTE_SLACK_CHANNEL',
    'ROOMOTE_SLACK_THREAD_TS',
    'ROOMOTE_COMMUNICATION_PROVIDER',
    'ROOMOTE_COMMUNICATION_CHANNEL_ID',
    'ROOMOTE_COMMUNICATION_THREAD_ID',
  ] as const;

  const roomoteEnv: Record<string, string> = {};

  for (const key of roomoteEnvKeys) {
    if (taskEnv?.[key]) {
      roomoteEnv[key] = taskEnv[key];
    }
  }

  const resolvedMcps: Record<string, McpServerConfig> = {};

  for (const [name, config] of Object.entries(BUILT_IN_MCPS)) {
    if (config.type === 'stdio') {
      const extraEnv =
        name === 'roomote'
          ? { ...stdioEnvExtras, ...roomoteEnv, ...config.env }
          : { ...stdioEnvExtras, ...config.env };

      resolvedMcps[name] = { ...config, env: extraEnv };
    } else {
      resolvedMcps[name] = config;
    }
  }

  // Add integration-provided MCP servers.
  if (integrations?.userMcpServers) {
    for (const [name, config] of Object.entries(integrations.userMcpServers)) {
      if (!config.url) {
        continue;
      }

      const integrationProxy = INTEGRATION_PROXY_MAP.get(name);

      if (integrationProxy) {
        if (
          integrationProxy.upstreamOrigin &&
          integrationProxy.upstreamPath &&
          isRawUpstreamUrl(
            config.url,
            integrationProxy.upstreamOrigin,
            integrationProxy.upstreamPath,
          )
        ) {
          console.warn(
            `[resolveBuiltInMcpServers] Skipping ${integrationProxy.name} MCP: raw upstream URL is not allowed (${config.url})`,
          );
          continue;
        }

        if (!isExpectedProxyUrl(config.url, integrationProxy.proxyPath)) {
          console.warn(
            `[resolveBuiltInMcpServers] Skipping ${integrationProxy.name} MCP: expected proxy path '${integrationProxy.proxyPath}' but received '${config.url}'`,
          );
          continue;
        }

        const apiUrl = resolveApiBaseUrl(taskEnv);
        const cloudToken = taskEnv?.ROOMOTE_CLOUD_TOKEN;

        if (!apiUrl || !cloudToken) {
          console.warn(
            `[resolveBuiltInMcpServers] Skipping ${integrationProxy.name} MCP: missing API base URL or ROOMOTE_CLOUD_TOKEN in task env`,
          );
          continue;
        }

        resolvedMcps[name] = {
          type: 'streamable-http',
          url: `${apiUrl}${integrationProxy.proxyPath}`,
          headers: withPreviewProxyBypassHeader(
            withTaskRunTokenAuthHeader(config.headers, cloudToken),
            taskEnv,
          ),
        };
        continue;
      }

      // Deployment custom servers arrive as Roomote proxy URLs; rewrite the
      // origin to the API base and inject the run token, exactly like the
      // curated integration proxies above. The real upstream credentials
      // stay server-side.
      const customProxyPath = parseCustomMcpProxyPath(config.url);

      if (customProxyPath) {
        const apiUrl = resolveApiBaseUrl(taskEnv);
        const cloudToken = taskEnv?.ROOMOTE_CLOUD_TOKEN;

        if (!apiUrl || !cloudToken) {
          console.warn(
            `[resolveBuiltInMcpServers] Skipping custom MCP '${name}': missing API base URL or ROOMOTE_CLOUD_TOKEN in task env`,
          );
          continue;
        }

        resolvedMcps[name] = {
          type: 'streamable-http',
          url: `${apiUrl}${customProxyPath}`,
          headers: withPreviewProxyBypassHeader(
            withTaskRunTokenAuthHeader(config.headers, cloudToken),
            taskEnv,
          ),
        };
        continue;
      }

      resolvedMcps[name] = {
        type: 'streamable-http',
        url: config.url,
        headers: config.headers,
      };
    }
  }

  const substitutionLookup = buildMcpSubstitutionLookup(
    taskEnv,
    operatorEnvVars,
  );

  const mergeOperatorMcpServers = (
    servers: EnvironmentMcpServers | undefined,
    source: 'environment' | 'deployment',
  ) => {
    if (!servers) {
      return;
    }

    for (const [name, config] of Object.entries(servers)) {
      if (resolvedMcps[name]) {
        console.warn(
          `[resolveBuiltInMcpServers] Skipping ${source} custom MCP '${name}': name conflicts with an existing MCP server`,
        );
        continue;
      }

      if ('command' in config) {
        resolvedMcps[name] = {
          type: 'stdio',
          command: config.command,
          args: config.args,
          env: {
            ...stdioEnvExtras,
            ...resolveConfigValues(config.env, substitutionLookup, {
              serverName: name,
              field: 'env',
            }),
          },
        };
      } else {
        resolvedMcps[name] = {
          type: 'streamable-http',
          url: config.url,
          headers: resolveConfigValues(config.headers, substitutionLookup, {
            serverName: name,
            field: 'headers',
          }),
        };
      }
    }
  };

  // Environment-specific servers first, then deployment-wide stdio servers:
  // the more specific scope wins name collisions.
  mergeOperatorMcpServers(environmentMcpServers, 'environment');
  mergeOperatorMcpServers(deploymentMcpServers, 'deployment');

  return resolvedMcps;
}
