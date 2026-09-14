import type {
  Command,
  DockerProject,
  EnvironmentConfig,
  EnvironmentRepositoryConfig,
  NamedPort,
  ServiceConfig,
} from '@roomote/types';
import { appendInitialPath, getDockerProjectLogFilePath } from '@roomote/types';

function withDefinedEntries<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function sanitizeDockerProjectForPrompt(
  project: DockerProject,
): Record<string, unknown> {
  const common = {
    type: project.type,
    name: project.name,
    repository: project.repository,
    working_dir: project.working_dir,
    ports: project.ports,
    required: project.required,
  };

  return withDefinedEntries(
    project.type === 'compose'
      ? {
          ...common,
          files: project.files,
          profiles: project.profiles,
          services: project.services,
        }
      : {
          ...common,
          context: project.context,
          dockerfile: project.dockerfile,
          target: project.target,
          command: project.command,
        },
  );
}

function sanitizeCommandForPrompt(command: Command): Record<string, unknown> {
  return withDefinedEntries({
    name: command.name,
    run: command.run,
    working_dir: command.working_dir,
    cwd: command.cwd,
    timeout: command.timeout,
    continue_on_error: command.continue_on_error,
    detached: command.detached,
    logfile: command.logfile,
  });
}

function sanitizeRepositoryForPrompt(
  repository: EnvironmentRepositoryConfig,
): Record<string, unknown> {
  return withDefinedEntries({
    repository: repository.repository,
    branch: repository.branch,
    tool_versions: repository.tool_versions,
    commands: repository.commands?.map(sanitizeCommandForPrompt),
  });
}

function sanitizeServiceForPrompt(
  service: ServiceConfig,
): string | Record<string, unknown> {
  if (typeof service === 'string') {
    return service;
  }

  return withDefinedEntries({
    name: service.name,
    port: service.port,
  });
}

function sanitizeNamedPortForPrompt(port: NamedPort): Record<string, unknown> {
  return withDefinedEntries({
    name: port.name,
    port: port.port,
    initial_path: port.initial_path,
    subdomain: port.subdomain,
    primary: port.primary,
    unauthenticated: port.unauthenticated,
    proxied: port.proxied,
    wildcard_prefix: port.wildcard_prefix,
  });
}

function hasRepositoryCommands(environmentConfig: EnvironmentConfig): boolean {
  return environmentConfig.repositories.some(
    (repository) => (repository.commands?.length ?? 0) > 0,
  );
}

function hasDetachedCommands(environmentConfig: EnvironmentConfig): boolean {
  return environmentConfig.repositories.some((repository) =>
    repository.commands?.some((command) => command.detached),
  );
}

export function sanitizeEnvironmentConfigForPrompt(
  environmentConfig: EnvironmentConfig,
): Record<string, unknown> {
  return withDefinedEntries({
    name: environmentConfig.name,
    description: environmentConfig.description,
    initialUrl: environmentConfig.initialUrl,
    ports: environmentConfig.ports?.map(sanitizeNamedPortForPrompt),
    tool_versions: environmentConfig.tool_versions,
    repositories:
      environmentConfig.repositories.length > 0
        ? environmentConfig.repositories.map(sanitizeRepositoryForPrompt)
        : undefined,
    services: environmentConfig.services?.map(sanitizeServiceForPrompt),
    docker_projects: environmentConfig.docker_projects?.map(
      sanitizeDockerProjectForPrompt,
    ),
  });
}

function getConfiguredPreviewUrls(
  environmentConfig: EnvironmentConfig | undefined,
  envVars: Record<string, string | undefined> | undefined,
): Array<{ name: string; url: string; primary: boolean }> {
  if (!environmentConfig?.ports?.length || !envVars) {
    return [];
  }

  return environmentConfig.ports
    .map((port) => {
      const name = port.name.toUpperCase();
      const previewUrl = envVars[`ROOMOTE_${name}_PREVIEW_URL`];
      const host =
        previewUrl ??
        (port.proxied === false ? undefined : envVars[`ROOMOTE_${name}_HOST`]);

      if (!host) {
        return null;
      }

      return {
        name,
        url: appendInitialPath(host, port.initial_path),
        primary: Boolean(port.primary),
      };
    })
    .filter((entry): entry is { name: string; url: string; primary: boolean } =>
      Boolean(entry),
    );
}

/**
 * Build a sandbox environment instruction block for the agent.
 *
 * Includes the environment config (stripped of secrets and the already-injected
 * agentInstructions) as JSON so the agent has visibility into its sandbox:
 * services, repositories, and startup commands.
 */
export function buildSandboxInstruction(
  hasLiveBrowser: boolean,
  environmentConfig?: EnvironmentConfig,
  options?: {
    envVars?: Record<string, string | undefined>;
    /**
     * True when repository setup commands are still running in the background
     * at instruction-build time, so the agent must not assume they finished.
     */
    backgroundEnvironmentSetupPending?: boolean;
  },
): string | undefined {
  const lines: string[] = [
    'You are running inside a cloud sandbox. Your filesystem and processes are isolated to this sandbox instance.',
    'Your sandbox user has passwordless `sudo`. When a missing system dependency blocks authorized work and `apt-get` is available, install only the necessary package in this sandbox rather than stopping; use noninteractive commands where suitable (for example, `sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y <package>`). These changes affect only this sandbox, not the host, and do not persist to other tasks or production; prefer existing or repository-managed tools and avoid unnecessary installs.',
  ];
  if (environmentConfig) {
    const safeConfig = sanitizeEnvironmentConfigForPrompt(environmentConfig);

    lines.push(
      '',
      'Environment configuration:',
      '```json',
      JSON.stringify(safeConfig, null, 2),
      '```',
    );

    const dockerProjects = environmentConfig.docker_projects ?? [];
    const hasConfiguredDockerProjects = dockerProjects.length > 0;

    if (options?.backgroundEnvironmentSetupPending) {
      if (
        hasRepositoryCommands(environmentConfig) ||
        hasConfiguredDockerProjects
      ) {
        lines.push(
          '',
          'Environment setup from this configuration runs automatically in the background and may still be executing while you work. This includes configured Docker projects and repository setup commands; do not start or re-run them yourself. Do not assume dependencies are installed or services are ready: check `.roomote/setup-status.json` in the workspace root for live status, and read the logs under `.roomote/setup-logs/` if something you need appears to be missing.',
          'If the requested work depends on setup that is still running (dependency installs, service startup, secret retrieval), wait for it instead of reporting that you are blocked and ending your turn: re-read `.roomote/setup-status.json` every 10-15 seconds until its top-level `state` reaches a terminal value (`completed`, `completed_with_warnings`, or `failed`), then continue the task from there. You will also receive an in-session `Environment setup update:` message when background setup finishes, so treat a still-running setup as normal startup, not a blocker to hand back to the user.',
        );
      }
    } else if (hasRepositoryCommands(environmentConfig)) {
      lines.push(
        '',
        'Repository setup commands from this environment configuration were already executed before your task started. Per-command results are recorded in `.roomote/setup-status.json` in the workspace root, with output logs under `.roomote/setup-logs/`.',
      );
    }

    if (hasDetachedCommands(environmentConfig)) {
      lines.push(
        'Any command marked `detached: true` was started in the background under PM2 supervision. Check its `logfile` and `pm2 status` before starting another copy.',
      );
    }

    if (hasConfiguredDockerProjects) {
      lines.push(
        '',
        'Roomote automatically starts configured Docker projects with Docker Compose during environment setup. Do not run `docker compose up`, build the projects, or start Docker yourself.',
      );

      if (options?.backgroundEnvironmentSetupPending) {
        lines.push(
          'Automatic Docker project startup may still be building images or waiting for health checks when your task begins. A project appears in `docker compose ls` only after its containers exist, so an empty listing while `.roomote/setup-status.json` is still `running` means startup is still in progress, not that Roomote skipped it.',
        );
      }

      lines.push(
        'Docker project startup logs:',
        ...dockerProjects.map(
          (project) =>
            `- ${project.name}: \`${getDockerProjectLogFilePath(project.name)}\``,
        ),
        'Use these logs to follow build and startup progress. Once a project appears, inspect it with `docker compose ls`, then use `docker compose --project-name <name> --file <file> ... ps` or `docker compose --project-name <name> --file <file> ... logs` (repeat `--file` for every listed config file).',
      );
    }

    const previewUrls = getConfiguredPreviewUrls(
      environmentConfig,
      options?.envVars,
    );

    if (previewUrls.length > 0) {
      lines.push('', 'Configured external preview URLs:');

      for (const previewUrl of previewUrls) {
        lines.push(
          `- ${previewUrl.name}${previewUrl.primary ? ' (primary)' : ''}: ${previewUrl.url}`,
        );
      }

      lines.push(
        'Use these shareable preview URLs when referring to external previews in replies or proof. Do not share raw machine hosts instead.',
      );

      if (options?.envVars?.ROOMOTE_AUTH_BYPASS_VALUE) {
        lines.push(
          'These external preview URLs are also reachable from this sandbox. The installed `agent-browser` wrapper automatically applies the task-scoped preview authentication cookie before `open`, `goto`, or `navigate`. Use the corresponding `ROOMOTE_<NAME>_PREVIEW_URL` when available and append the route you need to test; use the listed external URL otherwise. Use an external URL when you need to validate public-proxy, redirect, cookie, or hostname-dependent behavior. Never print, log, or share the bypass credential.',
        );
      }
    }
  }

  if (hasLiveBrowser) {
    lines.push(
      '',
      'This environment exposes a sandbox-local browser surface for visual proof captured through the `capture-visual-proof` skill.',
      "Use the exact hostname and port from the environment configuration's local browser URL for proof capture, preserving `localhost` versus `127.0.0.1` exactly as configured. Use configured external preview URLs only when the public proxy or hostname itself is part of what you need to validate.",
    );
  }

  return lines.join('\n');
}
