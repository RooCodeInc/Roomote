import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  deploymentMcpEnablements,
} from '@roomote/db/server';
import {
  getMcpIntegrationConnectionScope,
  type SlackMcpSetupAvailabilityKind,
  type SlackMcpSetupServiceDefinition,
  SLACK_MCP_SETUP_SERVICES,
} from '@roomote/types';

const LINEAR_ORG_CONNECTION_ROLE = 'linear_org_install';
const LINEAR_USER_CONNECTION_ROLE = 'linear_user_link';

type SlackMcpSetupStatus =
  | 'ready'
  | 'deployment_disabled'
  | 'deployment_auth_required'
  | 'user_auth_required';

export interface SlackMcpSetupDetectionActor {
  userId: string;
  apiBaseUrl?: string;
}

export interface SlackMcpSetupRequirement {
  serviceId: string;
  serviceName: string;
  reason: Exclude<SlackMcpSetupStatus, 'ready'>;
  canConfigure: boolean;
  settingsUrl: string;
  copyVariant:
    | 'user_auth_required'
    | 'deployment_disabled_admin'
    | 'deployment_disabled_non_admin'
    | 'deployment_auth_required_admin'
    | 'deployment_auth_required_non_admin';
}

interface ExtractedUrl {
  rawUrl: string;
  hostname: string;
  pathname: string;
}

interface OAuthTokenStatus {
  accessToken: string | null;
  tokenExpiresAt: Date | null;
  refreshToken: string | null;
}

interface AdminConfiguredConnectionStatus {
  authStatus: string | null;
}

function stripTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1]!;
    if (ch === ')' || ch === ',' || ch === '.' || ch === '!' || ch === '?') {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeUrlCandidate(rawUrl: string): string {
  const trimmed = stripTrailingUrlPunctuation(rawUrl.trim());
  return trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
}

function parseUrl(rawUrl: string): ExtractedUrl | null {
  try {
    const parsed = new URL(normalizeUrlCandidate(rawUrl));
    return {
      rawUrl,
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function extractUrlsFromSlackText(text: string): ExtractedUrl[] {
  const urls: ExtractedUrl[] = [];
  const seen = new Set<string>();

  const pushUrl = (raw: string | undefined) => {
    if (!raw) {
      return;
    }
    const parsed = parseUrl(raw);
    if (!parsed || seen.has(parsed.rawUrl)) {
      return;
    }
    seen.add(parsed.rawUrl);
    urls.push(parsed);
  };

  let index = 0;
  while (index < text.length) {
    if (text[index] === '[') {
      const closeBracket = text.indexOf(']', index + 1);
      if (
        closeBracket !== -1 &&
        closeBracket + 1 < text.length &&
        text[closeBracket + 1] === '('
      ) {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const candidate = text.slice(closeBracket + 2, closeParen);
          if (
            candidate.startsWith('http://') ||
            candidate.startsWith('https://') ||
            candidate.startsWith('www.')
          ) {
            pushUrl(candidate);
            index = closeParen + 1;
            continue;
          }
        }
      }
    }

    if (
      text.startsWith('https://', index) ||
      text.startsWith('http://', index) ||
      text.startsWith('www.', index)
    ) {
      let end = index;
      while (end < text.length) {
        const ch = text[end]!;
        if (
          ch === ' ' ||
          ch === '\t' ||
          ch === '\n' ||
          ch === '\r' ||
          ch === '<' ||
          ch === '>' ||
          ch === ']'
        ) {
          break;
        }
        end += 1;
      }
      pushUrl(text.slice(index, end));
      index = end;
      continue;
    }

    index += 1;
  }

  return urls;
}

function hostMatchesService(hostname: string, suffix: string): boolean {
  const normalizedSuffix = suffix.toLowerCase();
  return (
    hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`)
  );
}

function pathMatchesRule(
  pathname: string,
  rule: Pick<SlackMcpSetupServiceDefinition, 'pathPrefixes'> & {
    pathRegexes?: RegExp[];
  },
): boolean {
  if (
    rule.pathPrefixes?.length &&
    rule.pathPrefixes.some((prefix) =>
      pathname.startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }

  if (
    rule.pathRegexes?.length &&
    rule.pathRegexes.some((regex) => regex.test(pathname))
  ) {
    return true;
  }

  return !rule.pathPrefixes?.length && !rule.pathRegexes?.length;
}

export function matchSlackMcpSetupService(
  extractedUrl: Pick<ExtractedUrl, 'hostname' | 'pathname'>,
): SlackMcpSetupServiceDefinition | null {
  const normalizedPathname = extractedUrl.pathname.toLowerCase();

  for (const service of SLACK_MCP_SETUP_SERVICES) {
    if (service.excludedHostnames?.includes(extractedUrl.hostname)) {
      continue;
    }

    if (service.hostRules?.length) {
      const matchesHostRule = service.hostRules.some((rule) => {
        if (!hostMatchesService(extractedUrl.hostname, rule.hostSuffix)) {
          return false;
        }

        return pathMatchesRule(normalizedPathname, rule);
      });

      if (matchesHostRule) {
        return service;
      }

      continue;
    }

    const matchesHost = service.hostSuffixes.some((suffix) =>
      hostMatchesService(extractedUrl.hostname, suffix),
    );
    if (!matchesHost) {
      continue;
    }

    if (!pathMatchesRule(normalizedPathname, service)) {
      continue;
    }

    return service;
  }

  return null;
}

function buildSettingsUrl(
  service: SlackMcpSetupServiceDefinition,
  reason: Exclude<SlackMcpSetupStatus, 'ready'>,
  canConfigure: boolean,
  apiBaseUrl?: string,
): string {
  const baseUrl = apiBaseUrl ? stripTrailingSlashes(apiBaseUrl) : '';
  const path =
    reason === 'deployment_disabled' || reason === 'deployment_auth_required'
      ? service.deploymentSettingsPath
      : service.userSettingsPath;
  const settingsTargetKey =
    reason === 'deployment_auth_required'
      ? canConfigure
        ? 'deployment_auth_required_admin'
        : 'deployment_auth_required_non_admin'
      : reason === 'deployment_disabled'
        ? canConfigure
          ? 'deployment_disabled_admin'
          : 'deployment_disabled_non_admin'
        : undefined;
  const settingsTarget = settingsTargetKey
    ? service.settingsTargets?.[settingsTargetKey]
    : undefined;
  const query = new URLSearchParams();
  query.set(
    settingsTarget?.queryParam ?? 'service',
    settingsTarget?.value ?? service.id,
  );
  query.set('source', 'slack-mcp-interrupt');
  return `${baseUrl}${path}?${query.toString()}`;
}

function hasUsableOauthTokens(connection: OAuthTokenStatus): boolean {
  if (!connection.accessToken) {
    return false;
  }

  // Tokens without an expiration are valid until revoked.
  if (!connection.tokenExpiresAt) {
    return true;
  }

  // Expired tokens are still recoverable when a refresh token is present.
  if (connection.tokenExpiresAt <= new Date()) {
    return Boolean(connection.refreshToken);
  }

  return true;
}

async function resolveCuratedOauthStatus(
  serviceId: string,
  actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupStatus> {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: and(
      eq(deploymentMcpEnablements.mcpId, serviceId),
      eq(deploymentMcpEnablements.enabled, true),
    ),
    columns: { mcpId: true },
  });

  if (!enablement) {
    return 'deployment_disabled';
  }

  const connectionScope = getMcpIntegrationConnectionScope(serviceId);
  const connections = await db.query.mcpConnections.findMany({
    where: and(
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.mcpId, serviceId),
      connectionScope === 'deployment'
        ? isNull(mcpConnections.userId)
        : eq(mcpConnections.userId, actor.userId),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    columns: {
      authConfig: true,
      accessToken: true,
      tokenExpiresAt: true,
      refreshToken: true,
    },
  });

  for (const connection of connections) {
    const authConfig = connection.authConfig;
    if (!authConfig || !('type' in authConfig)) {
      continue;
    }

    if (hasUsableOauthTokens(connection)) {
      return 'ready';
    }
  }

  return connectionScope === 'deployment'
    ? 'deployment_auth_required'
    : 'user_auth_required';
}

async function resolveAdminConfiguredStatus(
  serviceId: string,
  actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupStatus> {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: and(
      eq(deploymentMcpEnablements.mcpId, serviceId),
      eq(deploymentMcpEnablements.enabled, true),
    ),
    columns: { mcpId: true },
  });

  if (!enablement) {
    return 'deployment_disabled';
  }

  const connectionScope = getMcpIntegrationConnectionScope(serviceId);
  const connections = await db.query.mcpConnections.findMany({
    where: and(
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.mcpId, serviceId),
      connectionScope === 'deployment'
        ? isNull(mcpConnections.userId)
        : eq(mcpConnections.userId, actor.userId),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    columns: {
      authStatus: true,
    },
  });

  for (const connection of connections as AdminConfiguredConnectionStatus[]) {
    if (connection.authStatus === 'authenticated') {
      return 'ready';
    }
  }

  return connectionScope === 'deployment'
    ? 'deployment_auth_required'
    : 'user_auth_required';
}

async function resolveLinearStatus(
  actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupStatus> {
  const [installation, userMapping] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
        eq(mcpConnections.authStatus, 'authenticated'),
        isNull(mcpConnections.userId),
      ),
      columns: { id: true },
    }),
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.userId, actor.userId),
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.connectionRole, LINEAR_USER_CONNECTION_ROLE),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
      columns: { id: true },
    }),
  ]);

  if (!installation) {
    return 'deployment_disabled';
  }

  return userMapping ? 'ready' : 'user_auth_required';
}

async function resolveDeploymentEnvVarStatus(
  service: SlackMcpSetupServiceDefinition,
  _actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupStatus> {
  const requiredDeploymentEnvVars = service.requiredDeploymentEnvVars ?? [];

  if (requiredDeploymentEnvVars.length === 0) {
    return 'ready';
  }

  const configuredEnvVars = await db.query.environmentVariables.findMany({
    columns: { name: true },
  });
  const configuredNames = new Set(
    configuredEnvVars.map((envVar) => envVar.name),
  );

  return requiredDeploymentEnvVars.every((name) => configuredNames.has(name))
    ? 'ready'
    : 'deployment_auth_required';
}

async function resolveSlackMcpSetupStatus(
  service: SlackMcpSetupServiceDefinition,
  actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupStatus> {
  switch (service.availabilityKind as SlackMcpSetupAvailabilityKind) {
    case 'curated_oauth':
      return await resolveCuratedOauthStatus(service.id, actor);
    case 'admin_configured':
      return await resolveAdminConfiguredStatus(service.id, actor);
    case 'deployment_env_var':
      return await resolveDeploymentEnvVarStatus(service, actor);
    case 'linear':
      return await resolveLinearStatus(actor);
  }
}

export async function detectSlackMcpSetupRequirement(
  text: string,
  actor: SlackMcpSetupDetectionActor,
): Promise<SlackMcpSetupRequirement | null> {
  const urls = extractUrlsFromSlackText(text);

  for (const extractedUrl of urls) {
    const service = matchSlackMcpSetupService(extractedUrl);
    if (!service) {
      continue;
    }

    const status = await resolveSlackMcpSetupStatus(service, actor);
    if (status === 'ready') {
      continue;
    }

    const canConfigure = true;

    return {
      serviceId: service.id,
      serviceName: service.name,
      reason: status,
      canConfigure,
      settingsUrl: buildSettingsUrl(
        service,
        status,
        canConfigure,
        actor.apiBaseUrl,
      ),
      copyVariant:
        status === 'user_auth_required'
          ? 'user_auth_required'
          : status === 'deployment_auth_required'
            ? canConfigure
              ? 'deployment_auth_required_admin'
              : 'deployment_auth_required_non_admin'
            : canConfigure
              ? 'deployment_disabled_admin'
              : 'deployment_disabled_non_admin',
    };
  }

  return null;
}
