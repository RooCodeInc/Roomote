import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  generateOpenCodeConfig,
  ROOMOTE_OPENCODE_SLACK_STOP_HOOK_FILE_NAME,
  type OpenCodeConfigMcpServer,
} from '../../../../run-task/agent-home';
import type { HarnessLogger } from '../../../../logging';
import {
  GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME,
  isInlineGoogleCredentialsValue,
  OPENCODE_AUTH_CONTENT_ENV_VAR_NAME,
} from '@roomote/types';

import {
  parseDirectMcpConfig,
  resolveHeaderEnvVarNameForOpenCode,
} from './mcp-config';
import type { DirectMcpConfig } from '../direct-mcp-config';

function normalizeOpenCodeRuntimeEnv(
  runtimeEnv: Record<string, string>,
): Record<string, string> {
  const normalized = { ...runtimeEnv };
  const homeDir = normalized.HOME ?? process.env.HOME ?? os.homedir();

  normalized.HOME = homeDir;
  normalized.XDG_CONFIG_HOME =
    normalized.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config');
  normalized.PATH = normalized.PATH?.trim() || process.env.PATH || '';

  return normalized;
}

function sanitizeEnvVarSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return sanitized || 'SERVER';
}

function createHeaderEnvVarName(
  serverName: string,
  headerName: string,
): string {
  return `ROOMOTE_DIRECT_MCP_HEADER_${sanitizeEnvVarSegment(
    serverName,
  )}_${sanitizeEnvVarSegment(headerName)}`;
}

function createBearerTokenEnvVarName(serverName: string): string {
  return `ROOMOTE_DIRECT_MCP_BEARER_TOKEN_${sanitizeEnvVarSegment(serverName)}`;
}

function convertHeaderEnvSubstitutions(options: {
  serverName: string;
  headerName: string;
  value: string;
  runtimeEnv: Record<string, string>;
}): string {
  const bareEnvVar = resolveHeaderEnvVarNameForOpenCode(options.value);

  if (bareEnvVar) {
    return `{env:${bareEnvVar}}`;
  }

  const openCodeEnvVarMatch = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(
    options.value.trim(),
  );

  if (openCodeEnvVarMatch?.[1]) {
    return `{env:${openCodeEnvVarMatch[1]}}`;
  }

  const trimmedValue = options.value.trim();
  const bearerEnvVarMatch = /^Bearer\s+\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(
    trimmedValue,
  );

  if (bearerEnvVarMatch?.[1]) {
    return `Bearer {env:${bearerEnvVarMatch[1]}}`;
  }

  const bearerOpenCodeEnvVarMatch =
    /^Bearer\s+\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(trimmedValue);

  if (bearerOpenCodeEnvVarMatch?.[1]) {
    return `Bearer {env:${bearerOpenCodeEnvVarMatch[1]}}`;
  }

  if (options.headerName.toLowerCase() === 'authorization') {
    const bearerTokenMatch = /^Bearer\s+(.+)$/u.exec(trimmedValue);
    const bearerToken = bearerTokenMatch?.[1]?.trim();

    if (bearerToken) {
      const envVarName = createBearerTokenEnvVarName(options.serverName);
      options.runtimeEnv[envVarName] = bearerToken;
      return `Bearer {env:${envVarName}}`;
    }
  }

  const envVarName = createHeaderEnvVarName(
    options.serverName,
    options.headerName,
  );
  options.runtimeEnv[envVarName] = options.value;

  return `{env:${envVarName}}`;
}

function normalizeOpenCodeMcpServers(
  mcpServers: Record<string, DirectMcpConfig>,
  runtimeEnv: Record<string, string>,
): OpenCodeConfigMcpServer[] {
  return Object.entries(mcpServers).map(([name, config]) => {
    if (config.type === 'stdio') {
      return {
        type: 'local',
        name,
        command: config.command,
        ...(config.args.length > 0 ? { args: config.args } : {}),
        ...(Object.keys(config.env).length > 0
          ? { environment: config.env }
          : {}),
      };
    }

    const headers = Object.fromEntries(
      Object.entries(config.headers).map(([headerName, headerValue]) => [
        headerName,
        convertHeaderEnvSubstitutions({
          serverName: name,
          headerName,
          value: headerValue,
          runtimeEnv,
        }),
      ]),
    );

    return {
      type: 'remote',
      name,
      url: config.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  });
}

export async function prepareOpenCodeCommandEnv(options: {
  runtimeEnv: Record<string, string>;
  workspacePath: string;
  mcpServers?: Record<string, unknown>;
  model?: string;
  developerInstructionsContent?: string;
  logger: HarnessLogger;
}): Promise<{ commandEnv: Record<string, string>; model?: string }> {
  const commandEnv = normalizeOpenCodeRuntimeEnv(options.runtimeEnv);
  const parsedMcpServers = Object.fromEntries(
    Object.entries(options.mcpServers ?? {}).flatMap(([name, config]) => {
      const parsedConfig = parseDirectMcpConfig(config);

      if (!parsedConfig) {
        options.logger.info(
          `Skipping unsupported OpenCode MCP config name=${name}`,
        );
        return [];
      }

      return [[name, parsedConfig]];
    }),
  );
  const homeDir = commandEnv.HOME;

  if (!homeDir) {
    throw new Error('OpenCode command environment did not resolve HOME.');
  }

  const { configContent, openCodeConfigDir, model } = generateOpenCodeConfig({
    homeDir,
    runtimeEnv: commandEnv,
    developerInstructionsContent: options.developerInstructionsContent,
    mcpServers: normalizeOpenCodeMcpServers(parsedMcpServers, commandEnv),
    model: options.model,
  });
  commandEnv.OPENCODE_CONFIG_CONTENT = configContent;
  commandEnv.ROOMOTE_NODE_EXECUTABLE = process.execPath;
  commandEnv.ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT = path.join(
    openCodeConfigDir,
    ROOMOTE_OPENCODE_SLACK_STOP_HOOK_FILE_NAME,
  );
  if (
    commandEnv.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE &&
    !commandEnv.ROOMOTE_SLACK_HOOK_DEBUG
  ) {
    commandEnv.ROOMOTE_SLACK_HOOK_DEBUG = '1';
  }

  // Materialize the ChatGPT subscription OAuth record into the opencode
  // harness `auth.json` and strip the env var. With the file in place,
  // opencode's built-in Codex plugin self-refreshes the access token once
  // per expiry and persists rotated tokens for the sandbox lifetime. Leaving
  // the env var set would make `Auth.all()` always return the static env
  // content, so every request after the first hour would re-refresh and
  // discard rotated tokens.
  await materializeOpenCodeAuthJson({
    commandEnv,
    homeDir,
    logger: options.logger,
  });

  // Materialize inline Google Vertex service-account JSON (Roomote lets
  // operators paste the JSON contents into GOOGLE_APPLICATION_CREDENTIALS)
  // into a real file, since Google's auth library only reads the variable
  // as a file path.
  await materializeGoogleApplicationCredentials({
    commandEnv,
    homeDir,
    logger: options.logger,
  });

  options.logger.info(
    `Prepared OpenCode config overlayDir=${openCodeConfigDir} workspace=${options.workspacePath} mcpServers=${
      Object.keys(parsedMcpServers).length
    } model=${model ?? 'roomote-model-default'}`,
  );

  return { commandEnv, model };
}

/**
 * Resolve the opencode data directory the harness uses for `auth.json`.
 * Mirrors opencode's `Global.Path.data`: `$XDG_DATA_HOME/opencode` when
 * `XDG_DATA_HOME` is set, otherwise `~/.local/share/opencode`.
 */
function resolveOpenCodeDataDir(
  homeDir: string,
  commandEnv: Record<string, string>,
): string {
  const xdgDataHome = commandEnv.XDG_DATA_HOME?.trim();

  if (xdgDataHome) {
    return path.join(xdgDataHome, 'opencode');
  }

  return path.join(homeDir, '.local', 'share', 'opencode');
}

/**
 * Write the ChatGPT subscription OAuth record (delivered as
 * `OPENCODE_AUTH_CONTENT`) to the harness `auth.json` so the inner opencode
 * process can self-refresh access tokens during long tasks, then strip the
 * env var so opencode reads the file instead of the static env content.
 * Failures are logged but never derail task startup — the env var remains
 * set on failure so opencode can still read the auth record from it as a
 * fallback.
 */
async function materializeOpenCodeAuthJson(options: {
  commandEnv: Record<string, string>;
  homeDir: string;
  logger: HarnessLogger;
}): Promise<void> {
  const { commandEnv, homeDir, logger } = options;
  const authContent = commandEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];

  if (!authContent) {
    return;
  }

  try {
    const dataDir = resolveOpenCodeDataDir(homeDir, commandEnv);
    await fs.mkdir(dataDir, { recursive: true });
    const authFilePath = path.join(dataDir, 'auth.json');
    await fs.writeFile(authFilePath, authContent, { mode: 0o600 });
    delete commandEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];
    logger.info(
      `Materialized ChatGPT subscription auth.json at ${authFilePath}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown auth.json write error';
    logger.info(
      `Failed to materialize ChatGPT subscription auth.json; falling back to ${OPENCODE_AUTH_CONTENT_ENV_VAR_NAME} env var: ${message}`,
    );
  }
}

/**
 * When `GOOGLE_APPLICATION_CREDENTIALS` carries inline service-account JSON
 * (the Vertex connect flow stores pasted JSON contents), write it to a file
 * and point the env var at that path — Google's auth library only accepts a
 * file path. Path values are left untouched. Failures are logged but never
 * derail task startup; Vertex requests would then fail with the library's
 * own credential error.
 */
async function materializeGoogleApplicationCredentials(options: {
  commandEnv: Record<string, string>;
  homeDir: string;
  logger: HarnessLogger;
}): Promise<void> {
  const { commandEnv, homeDir, logger } = options;
  const credentialsValue =
    commandEnv[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME];

  if (!isInlineGoogleCredentialsValue(credentialsValue)) {
    return;
  }

  try {
    const dataDir = resolveOpenCodeDataDir(homeDir, commandEnv);
    await fs.mkdir(dataDir, { recursive: true });
    const credentialsFilePath = path.join(
      dataDir,
      'google-application-credentials.json',
    );
    await fs.writeFile(credentialsFilePath, credentialsValue, { mode: 0o600 });
    commandEnv[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME] =
      credentialsFilePath;
    logger.info(
      `Materialized inline ${GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME} JSON at ${credentialsFilePath}`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown credentials write error';
    logger.info(
      `Failed to materialize inline ${GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME} JSON: ${message}`,
    );
  }
}
