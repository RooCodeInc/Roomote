import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { execa } from 'execa';
import YAML from 'yaml';

import {
  type DockerProject,
  type EnvironmentConfig,
  isServicesEnabledTaskPayloadKind,
  toComposeProjectName,
} from '@roomote/types';

import {
  appendDockerProjectLog,
  startDockerProjectLogFollower,
} from './docker-project-logs';

import { substituteEnvVars } from '../../../env';
import type { StartupLogger } from '../../../logging';

import { resolveComputeProviderFromEnv } from './shared';
import type { PrepareWorkspaceOptions, PrepareWorkspaceResult } from './types';

const DEFAULT_STARTUP_TIMEOUT_SECONDS = 600;

interface ContainerCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

type ContainerCommandRunner = (
  command: string,
  args: string[],
  options: ContainerCommandOptions,
) => Promise<{ stdout?: string; stderr?: string }>;

const runContainerCommand: ContainerCommandRunner = async (
  command,
  args,
  options,
) => {
  const subprocess = execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    reject: true,
    stdio: 'pipe',
    timeout: options.timeoutMs,
  });

  const result = await subprocess;

  return { stdout: result.stdout, stderr: result.stderr };
};

interface ResolvedDockerProject {
  project: DockerProject;
  projectName: string;
  projectRoot: string;
  composeFiles: string[];
  env: Record<string, string>;
  sensitiveValues: string[];
}

async function ensureDockerRuntime({
  preparedWorkspace,
  baseEnv,
  runCommand,
}: {
  preparedWorkspace: PrepareWorkspaceResult;
  baseEnv: Record<string, string>;
  runCommand: ContainerCommandRunner;
}): Promise<void> {
  const commandOptions = {
    cwd: preparedWorkspace.workspacePath,
    env: baseEnv,
    timeoutMs: 30_000,
  };

  try {
    await runCommand('docker', ['info'], commandOptions);
  } catch (initialError) {
    const dockerHost = baseEnv.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
    await runCommand(
      'sudo',
      [
        'sh',
        '-c',
        'nohup dockerd --host="$ROOMOTE_DOCKER_DAEMON_HOST" --log-level=error >/tmp/roomote-dockerd.log 2>&1 </dev/null &',
      ],
      {
        ...commandOptions,
        env: {
          ...commandOptions.env,
          ROOMOTE_DOCKER_DAEMON_HOST: dockerHost,
        },
      },
    );

    let lastError: unknown = initialError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await runCommand('docker', ['info'], commandOptions);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
  }

  await runCommand('docker', ['compose', 'version'], commandOptions);
}

function getDefinedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function resolveWithin(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the selected repository: ${relativePath}`);
  }

  return resolvedPath;
}

function findNamedPort(config: EnvironmentConfig, namedPort: string): number {
  const port = config.ports?.find(
    (candidate) => candidate.name.toUpperCase() === namedPort.toUpperCase(),
  );

  if (!port) {
    throw new Error(`Environment port '${namedPort}' is not configured`);
  }

  return port.port;
}

function buildPortOverrides(
  project: DockerProject,
  config: EnvironmentConfig,
): Record<string, { ports: Array<{ target: number; published: number }> }> {
  const services: Record<
    string,
    { ports: Array<{ target: number; published: number }> }
  > = {};

  for (const mapping of project.ports ?? []) {
    const serviceName = project.type === 'compose' ? mapping.service : 'app';
    if (!serviceName) {
      throw new Error(
        `Compose project '${project.name}' port '${mapping.named_port}' is missing a service`,
      );
    }

    const service = (services[serviceName] ??= { ports: [] });
    service.ports.push({
      target: mapping.container_port,
      published: findNamedPort(config, mapping.named_port),
    });
  }

  return services;
}

async function writeGeneratedComposeFile({
  preparedWorkspace,
  project,
  contents,
  suffix,
}: {
  preparedWorkspace: PrepareWorkspaceResult;
  project: DockerProject;
  contents: unknown;
  suffix: string;
}): Promise<string> {
  const outputDirectory = path.join(
    preparedWorkspace.workspacePath,
    '.roomote',
    'docker-projects',
  );
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `${toComposeProjectName(project.name)}.${suffix}.yaml`,
  );
  await fs.writeFile(outputPath, YAML.stringify(contents), 'utf8');
  return outputPath;
}

async function resolveDockerProject({
  project,
  config,
  preparedWorkspace,
  baseEnv,
}: {
  project: DockerProject;
  config: EnvironmentConfig;
  preparedWorkspace: PrepareWorkspaceResult;
  baseEnv: Record<string, string>;
}): Promise<ResolvedDockerProject> {
  const repositoryRoot = preparedWorkspace.repoPaths?.[project.repository];
  if (!repositoryRoot) {
    throw new Error(
      `Prepared repository path missing for Docker project '${project.name}': ${project.repository}`,
    );
  }

  const projectRoot = resolveWithin(repositoryRoot, project.working_dir ?? '.');
  const projectEnv = project.env ? substituteEnvVars(project.env, baseEnv) : {};
  const env = {
    ...baseEnv,
    ...projectEnv,
    COMPOSE_PROJECT_NAME: toComposeProjectName(project.name),
  };

  if (project.type === 'compose') {
    const composeFiles = project.files.map((file) =>
      resolveWithin(projectRoot, file),
    );
    await Promise.all(composeFiles.map((file) => fs.access(file)));

    const portOverrides = buildPortOverrides(project, config);
    if (Object.keys(portOverrides).length > 0) {
      composeFiles.push(
        await writeGeneratedComposeFile({
          preparedWorkspace,
          project,
          contents: { services: portOverrides },
          suffix: 'ports',
        }),
      );
    }

    return {
      project,
      projectName: env.COMPOSE_PROJECT_NAME,
      projectRoot,
      composeFiles,
      env,
      sensitiveValues: Object.values(projectEnv),
    };
  }

  const buildArgs = project.build_args
    ? substituteEnvVars(project.build_args, baseEnv)
    : {};

  const contextPath = resolveWithin(projectRoot, project.context ?? '.');
  const dockerfilePath = resolveWithin(
    projectRoot,
    project.dockerfile ?? 'Dockerfile',
  );
  await Promise.all([fs.access(contextPath), fs.access(dockerfilePath)]);

  const build: Record<string, unknown> = {
    context: contextPath,
    dockerfile: path.relative(contextPath, dockerfilePath),
  };
  if (project.target) build.target = project.target;
  if (Object.keys(buildArgs).length > 0) build.args = buildArgs;

  const service: Record<string, unknown> = { build };
  if (Object.keys(projectEnv).length > 0) service.environment = projectEnv;
  if (project.command) service.command = project.command;

  const generatedServices = buildPortOverrides(project, config);
  if (generatedServices.app) service.ports = generatedServices.app.ports;

  const composeFile = await writeGeneratedComposeFile({
    preparedWorkspace,
    project,
    contents: { services: { app: service } },
    suffix: 'dockerfile',
  });

  return {
    project,
    projectName: env.COMPOSE_PROJECT_NAME,
    projectRoot,
    composeFiles: [composeFile],
    env,
    sensitiveValues: [
      ...Object.values(projectEnv),
      ...Object.values(buildArgs),
    ],
  };
}

function buildComposeArgs(
  resolved: ResolvedDockerProject,
  subcommand: string[],
): string[] {
  const args = ['compose', '--project-name', resolved.projectName];

  for (const file of resolved.composeFiles) args.push('--file', file);
  if (resolved.project.type === 'compose') {
    for (const profile of resolved.project.profiles ?? []) {
      args.push('--profile', profile);
    }
  }

  return [...args, ...subcommand];
}

function redactContainerDiagnostics(
  value: string,
  sensitiveValues: string[],
): string {
  let redacted = value;
  for (const secret of sensitiveValues) {
    if (secret.length >= 8)
      redacted = redacted.replaceAll(secret, '[redacted]');
  }
  return redacted.slice(-12_000);
}

async function collectContainerDiagnostics(
  resolved: ResolvedDockerProject,
  runCommand: ContainerCommandRunner,
  commandOptions: ContainerCommandOptions,
): Promise<string> {
  const sections: string[] = [];
  for (const [label, command] of [
    ['Compose status', ['ps', '--all']],
    ['Recent Compose logs', ['logs', '--no-color', '--tail', '100']],
  ] as const) {
    try {
      const result = await runCommand(
        'docker',
        buildComposeArgs(resolved, [...command]),
        { ...commandOptions, timeoutMs: 30_000 },
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (output) {
        sections.push(
          `${label}:\n${redactContainerDiagnostics(
            output,
            resolved.sensitiveValues,
          )}`,
        );
      }
    } catch {
      // The original startup error is more useful than a secondary diagnostic
      // collection failure.
    }
  }
  return sections.join('\n\n');
}

async function startDockerProject({
  logger,
  resolved,
  runCommand,
}: {
  logger: StartupLogger;
  resolved: ResolvedDockerProject;
  runCommand: ContainerCommandRunner;
}): Promise<void> {
  const timeoutSeconds =
    resolved.project.startup_timeout_seconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS;
  const commandOptions = {
    cwd: resolved.projectRoot,
    env: resolved.env,
    timeoutMs: timeoutSeconds * 1_000,
  };

  logger.userLog.log(`Validating Docker project ${resolved.project.name}...`);
  const configResult = await runCommand(
    'docker',
    buildComposeArgs(resolved, ['config', '--quiet']),
    commandOptions,
  );
  if (configResult.stdout) logger.debug.log(configResult.stdout);

  logger.userLog.log(
    `Building and starting Docker project ${resolved.project.name}...`,
  );
  await appendDockerProjectLog(
    resolved.project.name,
    `[roomote] Building and starting Docker project ${resolved.project.name} (compose project ${resolved.projectName})...`,
  );
  const services =
    resolved.project.type === 'compose'
      ? (resolved.project.services ?? [])
      : [];
  // The provider lives in the worker's process env (injected at sandbox
  // creation), not in resolved.env, which only carries deployment and
  // user-facing vars.
  const waitForServices = resolveComputeProviderFromEnv() !== 'blaxel';
  if (!waitForServices) {
    logger.userLog.warn(
      'Blaxel does not support Docker healthchecks; continuing after Compose starts the services.',
    );
  }
  let startResult: Awaited<ReturnType<ContainerCommandRunner>>;
  try {
    startResult = await runCommand(
      'docker',
      buildComposeArgs(resolved, [
        'up',
        '--detach',
        '--build',
        '--remove-orphans',
        ...(waitForServices
          ? ['--wait', '--wait-timeout', String(timeoutSeconds)]
          : []),
        ...services,
      ]),
      commandOptions,
    );
  } catch (error) {
    const diagnostics = await collectContainerDiagnostics(
      resolved,
      runCommand,
      commandOptions,
    );
    if (diagnostics) logger.debug.error(diagnostics);
    // error.message includes Compose stderr, which can echo project env
    // values or build args — redact before this lands in the Logs panel.
    await appendDockerProjectLog(
      resolved.project.name,
      redactContainerDiagnostics(
        [
          `[roomote] Docker project ${resolved.project.name} failed to start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          diagnostics,
        ]
          .filter(Boolean)
          .join('\n\n'),
        resolved.sensitiveValues,
      ),
    );
    throw new Error(
      redactContainerDiagnostics(
        [error instanceof Error ? error.message : String(error), diagnostics]
          .filter(Boolean)
          .join('\n\n'),
        resolved.sensitiveValues,
      ),
      { cause: error },
    );
  }
  if (startResult.stdout) logger.debug.log(startResult.stdout);
  if (startResult.stderr) logger.debug.log(startResult.stderr);
  logger.userLog.log(`Docker project ${resolved.project.name} is ready`);

  const startOutput = [startResult.stdout, startResult.stderr]
    .filter(Boolean)
    .join('\n');

  if (startOutput) {
    await appendDockerProjectLog(
      resolved.project.name,
      redactContainerDiagnostics(startOutput, resolved.sensitiveValues),
    );
  }

  await appendDockerProjectLog(
    resolved.project.name,
    `[roomote] Docker project ${resolved.project.name} is ready; following container logs below.`,
  );
  await startDockerProjectLogFollower({
    projectName: resolved.project.name,
    composeArgs: buildComposeArgs(resolved, []),
    cwd: resolved.projectRoot,
    env: resolved.env,
  });
}

export async function initializeDockerProjects(
  logger: StartupLogger,
  options: PrepareWorkspaceOptions,
  preparedWorkspace: PrepareWorkspaceResult,
  runCommand: ContainerCommandRunner = runContainerCommand,
): Promise<void> {
  if (
    options.workspace.type !== 'environment' ||
    !isServicesEnabledTaskPayloadKind(options.taskRunType)
  ) {
    return;
  }

  const config = options.workspace.environmentConfig;
  const projects = config.docker_projects ?? [];
  if (projects.length === 0 && config.nested_docker !== true) return;

  const baseEnv = getDefinedEnv(options.envVars);

  // Create each project's log file up front so the Logs panel can start
  // tailing it (tail -f needs the file to exist) before startup output lands.
  for (const project of projects) {
    await appendDockerProjectLog(
      project.name,
      `[roomote] Preparing Docker project ${project.name}...`,
    );
  }

  try {
    await ensureDockerRuntime({ preparedWorkspace, baseEnv, runCommand });
  } catch (error) {
    const message = `Docker Compose is not available in this task environment: ${error instanceof Error ? error.message : String(error)}`;

    for (const project of projects) {
      await appendDockerProjectLog(project.name, `[roomote] ${message}`);
    }

    throw new Error(message, { cause: error });
  }

  if (projects.length === 0) {
    logger.userLog.log('Docker runtime is ready');
    return;
  }

  for (const project of projects) {
    let resolved: ResolvedDockerProject | undefined;

    try {
      resolved = await resolveDockerProject({
        project,
        config,
        preparedWorkspace,
        baseEnv,
      });
      await startDockerProject({ logger, resolved, runCommand });
    } catch (error) {
      const message = `Docker project '${project.name}' failed to start: ${error instanceof Error ? error.message : String(error)}`;
      // Before resolution succeeds no project env has been substituted, so
      // there is nothing to redact; afterwards the error can carry Compose
      // stderr echoing sensitive values.
      const redactedMessage = resolved
        ? redactContainerDiagnostics(message, resolved.sensitiveValues)
        : message;
      if (project.required === false) {
        logger.userLog.warn(
          `${redactedMessage} Continuing because it is optional.`,
        );
        // Log the redacted message, not the Error: its cause chain still
        // holds the original Compose error with unredacted stderr, and the
        // startup logger serializes causes into harness.log.
        logger.debug.error(redactedMessage);
        await appendDockerProjectLog(
          project.name,
          `[roomote] ${redactedMessage} Continuing because it is optional.`,
        );
        continue;
      }

      await appendDockerProjectLog(
        project.name,
        `[roomote] ${redactedMessage}`,
      );
      throw new Error(message, { cause: error });
    }
  }
}
