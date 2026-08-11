import * as dns from 'node:dns';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';

import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  appendInitialPath,
  createEnvironmentObservation,
  DEFAULT_AUTH_BYPASS_HEADER_NAME,
  getDockerProjectLogFilePath,
  toComposeProjectName,
  type EnvironmentObservation,
  type EnvironmentObservationCheck,
  type EnvironmentObservationStatus,
} from '@roomote/types';
import { execa } from 'execa';

import {
  doctorEnvironmentContextSchema,
  type DoctorEnvironmentContext,
} from '../../doctor/environment-context.js';
import {
  readEnvironmentSetupStatus,
  type EnvironmentSetupStatus,
} from '../../commands/setup/workspace/setup-status.js';
import type { ToolResult } from './types.js';

const COMMAND_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 8_000;
const HIGH_RESTART_COUNT = 5;
const RECENT_ERROR_PATTERN = /\b(error|fatal|exception|crash|eaddrinuse)\b/iu;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface DiagnoseEnvironmentDependencies {
  now: () => Date;
  readSetupStatus: (workspacePath: string) => EnvironmentSetupStatus | null;
  readFile: (filePath: string) => Promise<string>;
  stat: (filePath: string) => Promise<{ mtimeMs: number }>;
  runCommand: (
    command: string,
    args: string[],
    options: { cwd: string },
  ) => Promise<CommandResult>;
  fetch: typeof fetch;
  fetchViaDockerHost: (
    url: string,
    options: { headers?: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number }>;
  checkTcpPort: (port: number) => Promise<boolean>;
}

const defaultDependencies: DiagnoseEnvironmentDependencies = {
  now: () => new Date(),
  readSetupStatus: readEnvironmentSetupStatus,
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  stat: fs.stat,
  runCommand: async (command, args, options) => {
    const result = await execa(command, args, {
      cwd: options.cwd,
      extendEnv: true,
      reject: false,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
  fetch: globalThis.fetch,
  fetchViaDockerHost: (rawUrl, options) =>
    new Promise((resolve, reject) => {
      const url = new URL(rawUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          method: 'GET',
          headers: options.headers,
          signal: options.signal,
          lookup: (_hostname, lookupOptions, callback) =>
            dns.lookup('host.docker.internal', lookupOptions, callback),
        },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      request.once('error', reject);
      request.end();
    }),
  checkTcpPort: (port) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(2_000, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    }),
};

function sanitizeEvidence(
  text: string,
  sensitiveValues: readonly string[] = [],
) {
  let sanitized = redactSecrets(text);
  for (const value of sensitiveValues.filter(Boolean)) {
    sanitized = sanitized.replaceAll(value, '[redacted]');
  }

  return sanitized
    .replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s]+)/gu, '$1=[redacted]')
    .replace(/("[A-Z][A-Z0-9_]{2,}"\s*:\s*)"[^"]*"/gu, '$1"[redacted]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, '$1?[redacted]')
    .replace(
      /(\b--?(?:api-key|password|secret|token)(?:=|\s+))[^\s]+/giu,
      '$1[redacted]',
    )
    .replace(
      /(\b(?:password|secret|token)\s+(?:is|was)\s+)[^\s]+/giu,
      '$1[redacted]',
    )
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join('');
}

function lastLines(text: string, count = 20): string {
  return text.split(/\r?\n/u).slice(-count).join('\n').trim();
}

function resolveEvidencePath(workspacePath: string, filePath: string) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspacePath, filePath);
}

async function readEvidenceTail(
  workspacePath: string,
  filePath: string | undefined,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<string | undefined> {
  if (!filePath) return undefined;

  try {
    const content = await dependencies.readFile(
      resolveEvidencePath(workspacePath, filePath),
    );
    return sanitizeEvidence(lastLines(content), getRuntimeSensitiveValues());
  } catch {
    return `Log file: ${filePath} (unreadable)`;
  }
}

function observedAt(dependencies: DiagnoseEnvironmentDependencies) {
  return dependencies.now().toISOString();
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'command'
  );
}

function getRuntimeSensitiveValues(): string[] {
  return [
    process.env.ROOMOTE_CLOUD_TOKEN,
    process.env.ROOMOTE_AUTH_BYPASS_VALUE,
  ].filter((value): value is string => Boolean(value));
}

async function diagnoseSetupCommands(
  workspacePath: string,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<{
  checks: EnvironmentObservationCheck[];
  status: EnvironmentSetupStatus | null;
}> {
  const status = dependencies.readSetupStatus(workspacePath);
  const timestamp = observedAt(dependencies);
  if (!status) {
    return {
      status,
      checks: [
        {
          id: 'setup.commands',
          category: 'setup',
          title: 'Setup commands',
          status: 'unknown',
          severity: 'minor',
          summary: '.roomote/setup-status.json is missing or invalid',
          remediationHint: 'Run environment setup and retry diagnostics.',
          observedAt: timestamp,
        },
      ],
    };
  }

  const failedCommands = status.commands.filter(
    (command) => command.state === 'failed',
  );
  const checks: EnvironmentObservationCheck[] = [];
  for (const [index, command] of failedCommands.entries()) {
    const logTail = await readEvidenceTail(
      workspacePath,
      command.logFile,
      dependencies,
    );
    const detailLines = [
      command.logFile ? `Log file: ${command.logFile}` : undefined,
      command.error ? sanitizeEvidence(command.error) : undefined,
      logTail,
    ].filter((line): line is string => Boolean(line));
    checks.push({
      id: `setup.commands.${slugify(command.repository)}-${slugify(command.name)}-${index + 1}`,
      category: 'setup',
      title: command.name,
      status: 'fail',
      severity: 'major',
      summary: `${command.repository}: setup command failed${command.exitCode === undefined ? '' : ` with exit code ${command.exitCode}`}`,
      ...(detailLines.length > 0 ? { details: detailLines.join('\n') } : {}),
      remediationHint:
        'Inspect the command log and correct the environment setup definition.',
      observedAt: timestamp,
      ...(command.durationMs === undefined
        ? {}
        : { durationMs: command.durationMs }),
    });
  }

  let summaryStatus: EnvironmentObservationStatus = 'pass';
  if (failedCommands.length > 0 || status.state === 'failed') {
    summaryStatus = 'fail';
  } else if (status.state === 'running') {
    summaryStatus = 'unknown';
  } else if (
    status.state === 'completed_with_warnings' ||
    status.warnings.length
  ) {
    summaryStatus = 'warn';
  }

  checks.unshift({
    id: 'setup.commands',
    category: 'setup',
    title: 'Setup commands',
    status: summaryStatus,
    severity:
      summaryStatus === 'fail'
        ? 'major'
        : summaryStatus === 'pass'
          ? 'info'
          : 'minor',
    summary:
      status.state === 'running'
        ? 'Environment setup is still running'
        : `${status.commands.length - failedCommands.length}/${status.commands.length} setup commands completed without failure`,
    ...(status.warnings.length
      ? { details: sanitizeEvidence(status.warnings.join('\n')) }
      : {}),
    observedAt: timestamp,
  });

  return { checks, status };
}

function resolveWorkspaceChildPath(
  workspacePath: string,
  relativePath: string,
): string | null {
  const resolved = path.resolve(workspacePath, relativePath);
  const relative = path.relative(workspacePath, resolved);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? null
    : resolved;
}

function summarizeStatusEntries(entries: string[]): string {
  const displayed = entries.slice(0, 25);
  const remainder = entries.length - displayed.length;
  return `${displayed.join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}`;
}

async function diagnoseRepositoryChanges(
  workspacePath: string,
  setupStatus: EnvironmentSetupStatus | null,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck | undefined> {
  const baselines = setupStatus?.repositoryBaselines;
  if (!baselines) return undefined;

  const timestamp = observedAt(dependencies);
  if (baselines.length === 0) {
    return {
      id: 'setup.repository_changes',
      category: 'setup',
      title: 'Repository working-tree provenance',
      status: 'pass',
      severity: 'info',
      summary: 'No setup repository baselines were required',
      observedAt: timestamp,
    };
  }

  let status: EnvironmentObservationStatus = 'pass';
  let changedRepositories = 0;
  const details: string[] = [];
  for (const baseline of baselines) {
    const repositoryPath = resolveWorkspaceChildPath(
      workspacePath,
      baseline.path,
    );
    if (!repositoryPath) {
      status = 'unknown';
      details.push(`${baseline.repository}: invalid repository path`);
      continue;
    }

    const result = await dependencies.runCommand(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repositoryPath },
    );
    if (result.exitCode !== 0) {
      status = 'unknown';
      details.push(`${baseline.repository}: current git status unavailable`);
      continue;
    }

    const current = result.stdout.split(/\r?\n/u).filter(Boolean);
    const before = new Set(baseline.changes);
    const after = new Set(current);
    const appeared = current.filter((entry) => !before.has(entry));
    const disappeared = baseline.changes.filter((entry) => !after.has(entry));

    if (appeared.length === 0 && disappeared.length === 0) {
      details.push(`${baseline.repository}: unchanged from pre-setup state`);
      continue;
    }

    changedRepositories += 1;
    if (status === 'pass') status = 'warn';
    if (appeared.length > 0) {
      details.push(
        `${baseline.repository}: appeared since setup began: ${summarizeStatusEntries(appeared)}`,
      );
    }
    if (disappeared.length > 0) {
      details.push(
        `${baseline.repository}: no longer present since setup began: ${summarizeStatusEntries(disappeared)}`,
      );
    }
  }

  return {
    id: 'setup.repository_changes',
    category: 'setup',
    title: 'Repository working-tree provenance',
    status,
    severity: status === 'pass' ? 'info' : 'minor',
    summary:
      status === 'unknown'
        ? 'One or more repository working-tree comparisons were unavailable'
        : changedRepositories === 0
          ? 'Repository working trees are unchanged from their pre-setup state'
          : `${changedRepositories}/${baselines.length} repository working tree${baselines.length === 1 ? '' : 's'} changed after setup began`,
    details: sanitizeEvidence(details.join('\n')),
    remediationHint:
      changedRepositories > 0
        ? 'Review setup commands and runtime startup behavior; prefer idempotent setup that leaves repository source unchanged.'
        : undefined,
    observedAt: timestamp,
  };
}

type Pm2Process = {
  name?: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    unstable_restarts?: number;
    pm_log_path?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
  };
};

async function diagnoseDetachedHealth(
  workspacePath: string,
  setupStatus: EnvironmentSetupStatus | null,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck> {
  const timestamp = observedAt(dependencies);
  const detached =
    setupStatus?.commands.filter(
      (command) => command.state === 'started_detached',
    ) ?? [];
  if (detached.length === 0) {
    return {
      id: 'setup.detached_health',
      category: 'setup',
      title: 'Detached process health',
      status: setupStatus?.state === 'running' ? 'unknown' : 'pass',
      severity: 'info',
      summary:
        setupStatus?.state === 'running'
          ? 'No detached commands have finished launching yet'
          : 'No detached setup commands require health checks',
      observedAt: timestamp,
    };
  }

  const result = await dependencies.runCommand('pm2', ['--silent', 'jlist'], {
    cwd: workspacePath,
  });
  if (result.exitCode !== 0) {
    return {
      id: 'setup.detached_health',
      category: 'setup',
      title: 'Detached process health',
      status: 'fail',
      severity: 'major',
      summary: 'PM2 process state could not be read',
      ...(result.stderr || result.stdout
        ? { details: sanitizeEvidence(result.stderr || result.stdout) }
        : {}),
      remediationHint:
        'Confirm PM2 is installed and detached commands are supervised.',
      observedAt: timestamp,
    };
  }

  let processes: Pm2Process[] = [];
  try {
    processes = JSON.parse(result.stdout) as Pm2Process[];
  } catch {
    return {
      id: 'setup.detached_health',
      category: 'setup',
      title: 'Detached process health',
      status: 'unknown',
      severity: 'minor',
      summary: 'PM2 returned invalid process data',
      observedAt: timestamp,
    };
  }

  let status: EnvironmentObservationStatus = 'pass';
  const details: string[] = [];
  for (const command of detached) {
    const expectedLog = command.logFile
      ? resolveEvidencePath(workspacePath, command.logFile)
      : undefined;
    const process = expectedLog
      ? processes.find((candidate) =>
          [
            candidate.pm2_env?.pm_log_path,
            candidate.pm2_env?.pm_out_log_path,
            candidate.pm2_env?.pm_err_log_path,
          ].includes(expectedLog),
        )
      : undefined;

    if (!process) {
      status = 'fail';
      details.push(
        `${command.name}: no PM2 process matched ${command.logFile ?? 'its configured log'}`,
      );
      continue;
    }

    const processStatus = process.pm2_env?.status ?? 'unknown';
    const restarts =
      (process.pm2_env?.restart_time ?? 0) +
      (process.pm2_env?.unstable_restarts ?? 0);
    if (processStatus !== 'online') status = 'fail';
    else if (restarts >= HIGH_RESTART_COUNT && status !== 'fail')
      status = 'warn';

    let logNote = '';
    if (expectedLog) {
      try {
        const [tail, fileStat] = await Promise.all([
          readEvidenceTail(workspacePath, expectedLog, dependencies),
          dependencies.stat(expectedLog),
        ]);
        const ageSeconds = Math.max(
          0,
          Math.round((dependencies.now().getTime() - fileStat.mtimeMs) / 1_000),
        );
        if (tail && RECENT_ERROR_PATTERN.test(tail) && status === 'pass') {
          status = 'warn';
        }
        logNote = `; log updated ${ageSeconds}s ago${tail && RECENT_ERROR_PATTERN.test(tail) ? '; recent error lines detected' : ''}`;
      } catch {
        if (status === 'pass') status = 'warn';
        logNote = '; log file is unreadable';
      }
    }
    details.push(
      `${command.name}: PM2 ${process.name ?? 'process'} is ${processStatus}, restarts=${restarts}${logNote}`,
    );
  }

  return {
    id: 'setup.detached_health',
    category: 'setup',
    title: 'Detached process health',
    status,
    severity:
      status === 'fail' ? 'major' : status === 'warn' ? 'minor' : 'info',
    summary:
      status === 'pass'
        ? `${detached.length} detached process${detached.length === 1 ? ' is' : 'es are'} online`
        : 'One or more detached commands launched but are not healthy',
    details: sanitizeEvidence(details.join('\n')),
    remediationHint:
      status === 'pass'
        ? undefined
        : 'Inspect PM2 state and the configured detached-command logs.',
    observedAt: timestamp,
  };
}

function parseComposeProcesses(stdout: string): Array<Record<string, unknown>> {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed as Record<string, unknown>];
  } catch {
    return stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
}

async function diagnoseDockerProjects(
  workspacePath: string,
  context: DoctorEnvironmentContext,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck> {
  const timestamp = observedAt(dependencies);
  if (context.dockerProjects.length === 0) {
    return {
      id: 'docker.projects',
      category: 'docker',
      title: 'Docker projects',
      status: 'pass',
      severity: 'info',
      summary: 'No Docker projects are configured',
      observedAt: timestamp,
    };
  }

  const details: string[] = [];
  let status: EnvironmentObservationStatus = 'pass';
  await dependencies.runCommand(
    'docker',
    ['compose', 'ls', '--format', 'json'],
    {
      cwd: workspacePath,
    },
  );
  for (const project of context.dockerProjects) {
    const composeName = toComposeProjectName(project.name);
    const composeArgs = ['compose', '--project-name', composeName];
    for (const file of project.composeFiles) {
      composeArgs.push('--file', file);
    }
    for (const profile of project.profiles) {
      composeArgs.push('--profile', profile);
    }
    const result = await dependencies.runCommand(
      'docker',
      [...composeArgs, 'ps', '--all', '--format', 'json'],
      { cwd: project.cwd },
    );
    const processes =
      result.exitCode === 0 ? parseComposeProcesses(result.stdout) : [];
    const unhealthy = processes.filter((process) => {
      const state = String(process.State ?? process.Status ?? '').toLowerCase();
      const health = String(process.Health ?? '').toLowerCase();
      return !state.includes('running') || health === 'unhealthy';
    });
    const failed =
      result.exitCode !== 0 || processes.length === 0 || unhealthy.length > 0;
    if (failed) {
      const projectStatus: EnvironmentObservationStatus = project.required
        ? 'fail'
        : 'warn';
      if (projectStatus === 'fail' || status === 'pass') status = projectStatus;
      const logTail = await readEvidenceTail(
        workspacePath,
        getDockerProjectLogFilePath(project.name),
        dependencies,
      );
      details.push(
        `${project.name}: ${result.stderr || (processes.length === 0 ? 'no containers found' : `${unhealthy.length} unhealthy container(s)`)}${logTail ? `\n${logTail}` : ''}`,
      );
    } else {
      details.push(`${project.name}: ${processes.length} container(s) running`);
    }
  }

  return {
    id: 'docker.projects',
    category: 'docker',
    title: 'Docker projects',
    status,
    severity:
      status === 'fail' ? 'major' : status === 'warn' ? 'minor' : 'info',
    summary:
      status === 'pass'
        ? `${context.dockerProjects.length} Docker project${context.dockerProjects.length === 1 ? '' : 's'} healthy`
        : 'One or more Docker projects are unhealthy',
    details: sanitizeEvidence(details.join('\n')),
    remediationHint:
      status === 'pass'
        ? undefined
        : 'Inspect Docker Compose state and the referenced project log.',
    observedAt: timestamp,
  };
}

async function diagnoseServices(
  context: DoctorEnvironmentContext,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck[]> {
  return Promise.all(
    context.services.map(
      async (service): Promise<EnvironmentObservationCheck> => {
        const timestamp = observedAt(dependencies);
        const healthy =
          service.name === 'aws'
            ? (
                await dependencies.runCommand('aws', ['--version'], {
                  cwd: '/',
                })
              ).exitCode === 0
            : service.port > 0 &&
              (await dependencies.checkTcpPort(service.port));
        return {
          id: `service.${service.name}`,
          category: 'services',
          title: `${service.name} service`,
          status: healthy ? 'pass' : 'fail',
          severity: healthy ? 'info' : 'major',
          summary: healthy
            ? `${service.name} is reachable${service.port > 0 ? ` on 127.0.0.1:${service.port}` : ''}`
            : `${service.name} is not reachable${service.port > 0 ? ` on 127.0.0.1:${service.port}` : ''}`,
          remediationHint: healthy
            ? undefined
            : 'Restart the configured service and inspect its startup output.',
          observedAt: timestamp,
        };
      },
    ),
  );
}

function safeDisplayUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

function classifyFetchError(error: unknown) {
  const cause =
    error instanceof Error ? (error.cause as { code?: string }) : null;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (cause?.code === 'ECONNREFUSED') return 'connection refused';
  return 'connection failed';
}

async function checkHttpEndpoint(options: {
  id: string;
  title: string;
  url: string;
  displayUrl?: string;
  headers?: Record<string, string>;
  useDockerHost?: boolean;
  fallbackViaDockerHost?: boolean;
  dependencies: DiagnoseEnvironmentDependencies;
}): Promise<EnvironmentObservationCheck> {
  const startedAt = options.dependencies.now().getTime();
  const timestamp = observedAt(options.dependencies);
  try {
    const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const response = options.useDockerHost
      ? await options.dependencies.fetchViaDockerHost(options.url, {
          headers: options.headers,
          signal,
        })
      : await options.dependencies.fetch(options.url, {
          redirect: 'manual',
          headers: options.headers,
          signal,
        });
    const durationMs = Math.max(
      0,
      options.dependencies.now().getTime() - startedAt,
    );
    const status =
      response.status >= 200 && response.status < 400 ? 'pass' : 'fail';
    return {
      id: options.id,
      category: 'ports',
      title: options.title,
      status,
      severity: status === 'pass' ? 'info' : 'major',
      summary: `${safeDisplayUrl(options.displayUrl ?? options.url)} returned HTTP ${response.status} (${Math.floor(response.status / 100)}xx)`,
      remediationHint:
        status === 'pass'
          ? undefined
          : 'Inspect the service and preview proxy routing for this port.',
      observedAt: timestamp,
      durationMs,
    };
  } catch (error) {
    if (options.fallbackViaDockerHost && !options.useDockerHost) {
      return checkHttpEndpoint({
        ...options,
        displayUrl: options.displayUrl ?? options.url,
        useDockerHost: true,
        fallbackViaDockerHost: false,
      });
    }

    return {
      id: options.id,
      category: 'ports',
      title: options.title,
      status: 'fail',
      severity: 'major',
      summary: `${safeDisplayUrl(options.displayUrl ?? options.url)}: ${classifyFetchError(error)}`,
      observedAt: timestamp,
      durationMs: Math.max(0, options.dependencies.now().getTime() - startedAt),
      remediationHint:
        'Confirm the service is listening and the preview route is available.',
    };
  }
}

function shouldFallbackViaDockerHost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

async function diagnosePorts(
  context: DoctorEnvironmentContext,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck[]> {
  const checks: EnvironmentObservationCheck[] = [];
  for (const port of context.ports) {
    const loopbackUrl = appendInitialPath(
      `http://127.0.0.1:${port.port}`,
      port.initialPath,
    );
    checks.push(
      await checkHttpEndpoint({
        id: `port.${port.name}.loopback`,
        title: `${port.name} loopback`,
        url: loopbackUrl,
        dependencies,
      }),
    );

    if (!port.previewUrl) {
      checks.push({
        id: `port.${port.name}.preview`,
        category: 'ports',
        title: `${port.name} preview`,
        status: 'unknown',
        severity: 'minor',
        summary: `ROOMOTE_${port.name}_PREVIEW_URL is not configured`,
        observedAt: observedAt(dependencies),
      });
      continue;
    }

    const bypassHeaderValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;
    const bypassHeaderName =
      process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME ??
      DEFAULT_AUTH_BYPASS_HEADER_NAME;
    const previewUrl = appendInitialPath(port.previewUrl, port.initialPath);
    const headers = bypassHeaderValue
      ? { [bypassHeaderName]: bypassHeaderValue }
      : {};
    checks.push(
      await checkHttpEndpoint({
        id: `port.${port.name}.preview`,
        title: `${port.name} preview`,
        url: previewUrl,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        fallbackViaDockerHost: shouldFallbackViaDockerHost(previewUrl),
        dependencies,
      }),
    );
  }
  return checks;
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/u, '');
}

function parseMiseVersion(stdout: string) {
  const line = stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  return line.trim().split(/\s+/u).at(-1) ?? '';
}

async function resolveToolVersion(
  tool: string,
  cwd: string,
  dependencies: DiagnoseEnvironmentDependencies,
) {
  const miseResult = await dependencies.runCommand('mise', ['current', tool], {
    cwd,
  });
  if (miseResult.exitCode === 0 && miseResult.stdout.trim()) {
    return parseMiseVersion(miseResult.stdout);
  }

  const command = tool === 'nodejs' ? 'node' : tool;
  const directResult = await dependencies.runCommand(command, ['--version'], {
    cwd,
  });
  return directResult.exitCode === 0 ? directResult.stdout.trim() : '';
}

async function diagnoseToolVersions(
  context: DoctorEnvironmentContext,
  dependencies: DiagnoseEnvironmentDependencies,
): Promise<EnvironmentObservationCheck> {
  const timestamp = observedAt(dependencies);
  if (context.toolVersions.length === 0) {
    return {
      id: 'tooling.versions',
      category: 'tooling',
      title: 'Tool versions',
      status: 'pass',
      severity: 'info',
      summary: 'No environment tool versions are declared',
      observedAt: timestamp,
    };
  }

  const details: string[] = [];
  let status: EnvironmentObservationStatus = 'pass';
  for (const declaration of context.toolVersions) {
    const actualVersion = await resolveToolVersion(
      declaration.tool,
      declaration.cwd,
      dependencies,
    );
    const matches =
      actualVersion.length > 0 &&
      normalizeVersion(actualVersion) ===
        normalizeVersion(declaration.declaredVersion);
    if (!matches) status = 'fail';
    details.push(
      `${declaration.scope}: ${declaration.tool} declared ${declaration.declaredVersion}, resolved ${actualVersion || 'unavailable'}`,
    );
  }

  return {
    id: 'tooling.versions',
    category: 'tooling',
    title: 'Tool versions',
    status,
    severity: status === 'pass' ? 'info' : 'major',
    summary:
      status === 'pass'
        ? `${context.toolVersions.length} declared tool version${context.toolVersions.length === 1 ? '' : 's'} match the runtime`
        : 'One or more resolved tool versions do not match their declarations',
    details: details.join('\n'),
    remediationHint:
      status === 'pass'
        ? undefined
        : 'Install the declared versions with mise and confirm repository-local pins.',
    observedAt: timestamp,
  };
}

function diagnoseEnvContract(
  context: DoctorEnvironmentContext,
  dependencies: DiagnoseEnvironmentDependencies,
): EnvironmentObservationCheck {
  const present = new Set(context.presentEnvVarNames);
  const entries = [
    ...context.configuredEnvVars.map((entry) => ({
      name: entry.name,
      source: 'environment config',
      state: entry.withheld
        ? 'withheld'
        : present.has(entry.name)
          ? 'configured'
          : 'missing',
    })),
    ...context.services.flatMap((service) =>
      service.envVarNames.map((name) => ({
        name,
        source: `service.${service.name}`,
        state: present.has(name) ? 'configured' : 'missing',
      })),
    ),
  ];
  const missing = entries.filter((entry) => entry.state === 'missing');
  return {
    id: 'env.contract',
    category: 'environment',
    title: 'Environment contract',
    status: missing.length > 0 ? 'warn' : 'pass',
    severity: missing.length > 0 ? 'minor' : 'info',
    summary:
      entries.length === 0
        ? 'No environment-config or service-provided variables are expected'
        : `${entries.length - missing.length}/${entries.length} expected environment variables are configured or intentionally withheld`,
    ...(entries.length > 0
      ? {
          details: entries
            .map((entry) => `${entry.name}: ${entry.state} (${entry.source})`)
            .join('\n'),
        }
      : {}),
    remediationHint:
      missing.length > 0
        ? `Configure the missing variable names: ${missing.map((entry) => entry.name).join(', ')}`
        : undefined,
    observedAt: observedAt(dependencies),
  };
}

function emptyEnvironmentContext(): DoctorEnvironmentContext {
  return {
    ports: [],
    services: [],
    dockerProjects: [],
    toolVersions: [],
    configuredEnvVars: [],
    presentEnvVarNames: [],
  };
}

function parseDoctorEnvironmentContext(raw: string | undefined): {
  context: DoctorEnvironmentContext;
  check: EnvironmentObservationCheck;
} {
  const observedAt = new Date().toISOString();
  if (!raw) {
    return {
      context: emptyEnvironmentContext(),
      check: {
        id: 'context.available',
        category: 'context',
        title: 'Environment context',
        status: 'unknown',
        severity: 'critical',
        summary: 'Environment context is unavailable',
        remediationHint:
          'Run Doctor in a persisted Roomote environment with runtime context',
        observedAt,
      },
    };
  }

  try {
    return {
      context: doctorEnvironmentContextSchema.parse(JSON.parse(raw) as unknown),
      check: {
        id: 'context.available',
        category: 'context',
        title: 'Environment context',
        status: 'pass',
        severity: 'info',
        summary: 'Environment context is available',
        observedAt,
      },
    };
  } catch (error) {
    return {
      context: emptyEnvironmentContext(),
      check: {
        id: 'context.available',
        category: 'context',
        title: 'Environment context',
        status: 'unknown',
        severity: 'critical',
        summary: 'Environment context is invalid',
        details: sanitizeEvidence(
          error instanceof Error ? error.message : String(error),
        ),
        remediationHint:
          'Run Doctor in a persisted Roomote environment with valid runtime context',
        observedAt,
      },
    };
  }
}

export async function diagnoseEnvironment(options: {
  workspacePath: string;
  context: DoctorEnvironmentContext;
  contextCheck?: EnvironmentObservationCheck;
  dependencies?: Partial<DiagnoseEnvironmentDependencies>;
}): Promise<EnvironmentObservation> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const setup = await diagnoseSetupCommands(
    options.workspacePath,
    dependencies,
  );
  const checks: EnvironmentObservationCheck[] = [
    ...(options.contextCheck ? [options.contextCheck] : []),
    ...setup.checks,
  ];
  const repositoryChanges = await diagnoseRepositoryChanges(
    options.workspacePath,
    setup.status,
    dependencies,
  );
  if (repositoryChanges) checks.push(repositoryChanges);
  checks.push(
    await diagnoseDetachedHealth(
      options.workspacePath,
      setup.status,
      dependencies,
    ),
  );
  checks.push(
    await diagnoseDockerProjects(
      options.workspacePath,
      options.context,
      dependencies,
    ),
  );
  checks.push(...(await diagnoseServices(options.context, dependencies)));
  checks.push(...(await diagnosePorts(options.context, dependencies)));
  checks.push(await diagnoseToolVersions(options.context, dependencies));
  checks.push(diagnoseEnvContract(options.context, dependencies));

  return createEnvironmentObservation(checks, {
    generatedAt: observedAt(dependencies),
    sensitiveValues: getRuntimeSensitiveValues(),
  });
}

function formatEnvironmentObservation(
  observation: EnvironmentObservation,
): string {
  const lines = [
    '# Environment diagnostics',
    '',
    `Overall probe status: **${observation.overallStatus.toUpperCase()}**`,
    `Generated: ${observation.generatedAt}`,
    'This observation is evidence for Doctor assessment; it is not a verification result or repair authorization.',
    '',
  ];
  for (const check of observation.checks) {
    lines.push(
      `- **${check.status.toUpperCase()}** \`${check.id}\` - ${check.summary}`,
    );
    if (check.details)
      lines.push(`  Evidence: ${check.details.replaceAll('\n', '\n  ')}`);
    if (check.remediationHint)
      lines.push(`  Remediation: ${check.remediationHint}`);
  }
  return lines.join('\n');
}

export async function handleDiagnoseEnvironment(): Promise<ToolResult> {
  const workspacePath = process.env.ROOMOTE_WORKSPACE_PATH;
  if (!workspacePath) {
    return {
      content: [
        {
          type: 'text',
          text: 'ROOMOTE_WORKSPACE_PATH is not configured; diagnostics cannot inspect this workspace.',
        },
      ],
    };
  }

  try {
    const parsedContext = parseDoctorEnvironmentContext(
      process.env.ROOMOTE_DOCTOR_ENVIRONMENT_CONTEXT,
    );
    const observation = await diagnoseEnvironment({
      workspacePath,
      context: parsedContext.context,
      contextCheck: parsedContext.check,
    });
    return {
      content: [
        { type: 'text', text: formatEnvironmentObservation(observation) },
      ],
      structuredContent: observation,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Environment diagnostics failed: ${sanitizeEvidence(error instanceof Error ? error.message : String(error))}`,
        },
      ],
    };
  }
}
