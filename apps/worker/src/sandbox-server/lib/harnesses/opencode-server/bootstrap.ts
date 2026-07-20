import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  generateOpenCodeConfig,
  OPENCODE_AUTH_FILE_NAME,
  resolveOpenCodeDataDir,
  ROOMOTE_OPENCODE_SLACK_STOP_HOOK_FILE_NAME,
  type OpenCodeConfigMcpServer,
} from '../../../../run-task/agent-home';
import type { HarnessLogger } from '../../../../logging';
import {
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME,
  OPENCODE_AUTH_CONTENT_ENV_VAR_NAME,
  type ReasoningEffort,
} from '@roomote/types';

import {
  parseDirectMcpConfig,
  resolveHeaderEnvVarNameForOpenCode,
} from './mcp-config';
import type { DirectMcpConfig } from '../direct-mcp-config';
import {
  resolveOpenCodePluginSeedVersion,
  seedOpenCodePluginDependencies,
} from './seed-opencode-plugin-deps';

const OPENCODE_BASH_ENV_FILE_NAME = 'roomote-opencode-env.sh';

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
  reasoningEffortOverride?: ReasoningEffort;
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
    reasoningEffortOverride: options.reasoningEffortOverride,
  });
  commandEnv.OPENCODE_CONFIG_CONTENT = configContent;
  // Prevent the checked-out repo's opencode.json / .opencode plugins and MCP
  // servers from merging into the harness. Additive repo MCP would otherwise
  // execute at serve start with harness credentials (pre-LLM RCE).
  commandEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
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

  await materializeOpenCodeBashEnvOverlay({ commandEnv, homeDir });

  // OpenCode always Arborist-installs @opencode-ai/plugin into the config dir
  // and waits on that work when any plugins (including Roomote file plugins)
  // are present. Pre-complete the seed so first POST /session does not hang
  // on a sticky registry fetch.
  const pluginSeedVersion = await resolveOpenCodePluginSeedVersion({
    env: commandEnv,
    pathEnv: commandEnv.PATH,
  });
  await seedOpenCodePluginDependencies({
    configDir: openCodeConfigDir,
    version: pluginSeedVersion,
    logger: options.logger,
    env: commandEnv,
  });

  options.logger.info(
    `Prepared OpenCode config overlayDir=${openCodeConfigDir} workspace=${options.workspacePath} mcpServers=${
      Object.keys(parsedMcpServers).length
    } model=${model ?? 'roomote-model-default'} pluginSeedVersion=${pluginSeedVersion}`,
  );

  return { commandEnv, model };
}

function quoteForBash(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * OPENCODE_COMMAND may launch through `bash -lc`. Non-interactive Bash sources
 * BASH_ENV after inheriting the prepared command environment, and an older
 * Roomote shared env file can still contain disabled-provider credentials.
 * Point BASH_ENV at an overlay that sources the shared file first, then
 * explicitly removes those credentials again.
 */
async function materializeOpenCodeBashEnvOverlay(options: {
  commandEnv: Record<string, string>;
  homeDir: string;
}): Promise<void> {
  const { commandEnv, homeDir } = options;
  const inheritedBashEnv = commandEnv.BASH_ENV?.trim();

  if (!inheritedBashEnv) {
    return;
  }

  const dataDir = resolveOpenCodeDataDir(homeDir, commandEnv);
  await fs.mkdir(dataDir, { recursive: true });
  const overlayPath = path.join(dataDir, OPENCODE_BASH_ENV_FILE_NAME);
  await fs.writeFile(
    overlayPath,
    [
      '#!/usr/bin/env bash',
      '# Generated by Roomote. Do not edit.',
      `source ${quoteForBash(inheritedBashEnv)}`,
      ...DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES.map(
        (envVarName) => `unset ${envVarName}`,
      ),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  commandEnv.BASH_ENV = overlayPath;
}

async function removeOpenCodeAuthJsonForChatGptGateway(options: {
  commandEnv: Record<string, string>;
  homeDir: string;
  logger: HarnessLogger;
}): Promise<void> {
  const dataDir = resolveOpenCodeDataDir(options.homeDir, options.commandEnv);
  const authFilePath = path.join(dataDir, OPENCODE_AUTH_FILE_NAME);

  try {
    // A resumed filesystem can contain an auth file from a run created before
    // gateway mode, or from a best-effort snapshot scrub that failed. Remove
    // the complete file before OpenCode starts: any `openai` auth entry would
    // reactivate the built-in Codex fetch hook and bypass Roomote's gateway.
    await fs.rm(authFilePath, { force: true });
    options.logger.info(
      `Ensured OpenCode auth.json is absent for ChatGPT gateway mode at ${authFilePath}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown auth.json remove error';

    // Fail closed. Starting OpenCode with a stale OAuth record would put the
    // long-lived subscription credential back in use inside the sandbox.
    throw new Error(
      `Failed to remove OpenCode auth.json for ChatGPT gateway mode: ${message}`,
      { cause: error },
    );
  }
}

/**
 * In direct-subscription mode, write the OAuth record delivered as
 * `OPENCODE_AUTH_CONTENT` to the harness `auth.json` so OpenCode can refresh
 * it during long tasks. In gateway mode, remove any snapshotted auth file and
 * fail closed if that cleanup cannot be completed before OpenCode starts.
 */
async function materializeOpenCodeAuthJson(options: {
  commandEnv: Record<string, string>;
  homeDir: string;
  logger: HarnessLogger;
}): Promise<void> {
  const { commandEnv, homeDir, logger } = options;
  const routeChatGptThroughGateway =
    commandEnv[INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME] === '1';
  const routeGitHubCopilotThroughGateway =
    commandEnv.R_INFERENCE_GATEWAY_GITHUB_COPILOT === '1';

  if (routeChatGptThroughGateway || routeGitHubCopilotThroughGateway) {
    // Defense in depth: dequeue and run-task already omit this value, but a
    // conflicting deployment env must not survive into the OpenCode process.
    delete commandEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];
    await removeOpenCodeAuthJsonForChatGptGateway(options);
    return;
  }

  const authContent = commandEnv[OPENCODE_AUTH_CONTENT_ENV_VAR_NAME];

  if (!authContent) {
    return;
  }

  try {
    const dataDir = resolveOpenCodeDataDir(homeDir, commandEnv);
    await fs.mkdir(dataDir, { recursive: true });
    const authFilePath = path.join(dataDir, OPENCODE_AUTH_FILE_NAME);
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
