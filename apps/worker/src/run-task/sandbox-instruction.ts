import type {
  Command,
  DockerProject,
  EnvironmentConfig,
  EnvironmentRepositoryConfig,
  NamedPort,
  ServiceConfig,
} from '@roomote/types';
import { appendInitialPath } from '@roomote/types';

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
    repositories: environmentConfig.repositories.map(
      sanitizeRepositoryForPrompt,
    ),
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
      if (port.proxied === false) {
        return null;
      }

      const host = envVars[`ROOMOTE_${port.name.toUpperCase()}_HOST`];

      if (!host) {
        return null;
      }

      return {
        name: port.name.toUpperCase(),
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
  },
): string | undefined {
  const lines: string[] = [
    'You are running inside a cloud sandbox. Your filesystem and processes are isolated to this sandbox instance.',
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

    if (hasRepositoryCommands(environmentConfig)) {
      lines.push(
        '',
        'Repository setup commands from this environment configuration were already executed before your task started.',
      );
    }

    if (hasDetachedCommands(environmentConfig)) {
      lines.push(
        'Any command marked `detached: true` was started in the background under PM2 supervision. Check its `logfile` and `pm2 status` before starting another copy.',
      );
    }

    if (environmentConfig.docker_projects?.length) {
      lines.push(
        '',
        'Configured Docker projects were built and started with Docker Compose before your task began. Use `docker compose` with the configured project files when inspecting them, and do not start duplicate copies.',
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
    }
  }

  if (hasLiveBrowser) {
    lines.push(
      '',
      'This environment exposes a sandbox-local browser surface for delegated visual proof.',
      "Use the exact hostname and port from the environment configuration's local browser URL for proof capture. Preserve `localhost` versus `127.0.0.1` exactly as configured, and treat configured external preview URLs as shareable links only.",
    );
  }

  return lines.join('\n');
}
