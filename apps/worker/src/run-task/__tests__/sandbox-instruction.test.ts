import type { EnvironmentConfig } from '@roomote/types';

import {
  buildSandboxInstruction,
  sanitizeEnvironmentConfigForPrompt,
} from '../sandbox-instruction';

describe('sanitizeEnvironmentConfigForPrompt', () => {
  it('omits repository details when the environment has none', () => {
    expect(
      sanitizeEnvironmentConfigForPrompt({
        name: 'Tools',
        repositories: [],
      }),
    ).toEqual({ name: 'Tools' });
  });

  it('keeps only whitelisted prompt-safe fields', () => {
    const environmentConfig: EnvironmentConfig = {
      name: 'Sandbox',
      description: 'Test environment',
      initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/auth/dev-login',
          primary: true,
          subdomain: 'app',
          unauthenticated: false,
          proxied: true,
          wildcard_prefix: false,
        },
      ],
      agentInstructions: 'Start with the web app',
      tool_versions: {
        node: '22.14.0',
      },
      env: {
        ROOT_SECRET: 'root-secret',
      },
      auth_bypass_header: 'top-secret-bypass',
      auth_bypass_header_name: 'x-custom-bypass',
      repositories: [
        {
          repository: 'owner/repo',
          branch: 'main',
          tool_versions: {
            node: '22.0.0',
          },
          commands: [
            {
              name: 'Install deps',
              run: 'pnpm install',
              timeout: 600,
              continue_on_error: false,
              env: {
                NPM_TOKEN: 'npm-secret',
              },
            },
            {
              name: 'Start app',
              run: 'pnpm dev',
              timeout: 600,
              continue_on_error: false,
              detached: true,
              logfile: '/tmp/web.log',
              env: {
                API_KEY: 'api-secret',
              },
            },
          ],
        },
      ],
      services: ['postgres17', { name: 'redis7', port: 6380 }],
      docker_projects: [
        {
          type: 'compose',
          name: 'app',
          repository: 'owner/repo',
          files: ['compose.yaml'],
          env: { COMPOSE_SECRET: 'do-not-print' },
        },
      ],
    };

    expect(sanitizeEnvironmentConfigForPrompt(environmentConfig)).toEqual({
      name: 'Sandbox',
      description: 'Test environment',
      initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/auth/dev-login',
          subdomain: 'app',
          primary: true,
          unauthenticated: false,
          proxied: true,
          wildcard_prefix: false,
        },
      ],
      tool_versions: {
        node: '22.14.0',
      },
      repositories: [
        {
          repository: 'owner/repo',
          branch: 'main',
          tool_versions: {
            node: '22.0.0',
          },
          commands: [
            {
              name: 'Install deps',
              run: 'pnpm install',
              timeout: 600,
              continue_on_error: false,
            },
            {
              name: 'Start app',
              run: 'pnpm dev',
              timeout: 600,
              continue_on_error: false,
              detached: true,
              logfile: '/tmp/web.log',
            },
          ],
        },
      ],
      services: ['postgres17', { name: 'redis7', port: 6380 }],
      docker_projects: [
        {
          type: 'compose',
          name: 'app',
          repository: 'owner/repo',
          files: ['compose.yaml'],
        },
      ],
    });
  });
});

describe('buildSandboxInstruction', () => {
  it('tells the agent that Docker projects start automatically and may still be running', () => {
    const environmentConfig = {
      name: 'Sandbox',
      repositories: [{ repository: 'owner/repo' }],
      docker_projects: [
        {
          type: 'compose' as const,
          name: 'app',
          repository: 'owner/repo',
          files: ['compose.yaml'],
        },
      ],
    };
    const instruction = buildSandboxInstruction(false, environmentConfig, {
      backgroundEnvironmentSetupPending: true,
    });

    expect(instruction).toContain(
      'Roomote automatically starts configured Docker projects with Docker Compose during environment setup.',
    );
    expect(instruction).toContain(
      'Do not run `docker compose up`, build the projects, or start Docker yourself.',
    );
    expect(instruction).toContain(
      'an empty listing while `.roomote/setup-status.json` is still `running` means startup is still in progress, not that Roomote skipped it',
    );
    expect(instruction).toContain(
      '- app: `/tmp/roomote-docker-projects/roomote-app.log`',
    );
    expect(instruction).toContain(
      're-read `.roomote/setup-status.json` every 10-15 seconds',
    );
    expect(instruction).toContain(
      '`docker compose --project-name <name> --file <file> ... ps`',
    );
    expect(instruction).toContain(
      'repeat `--file` for every listed config file',
    );
    expect(instruction).not.toContain(
      'Inspect them with `docker compose ps` and `docker compose logs`',
    );
    expect(instruction).not.toContain(
      'were built and started with Docker Compose before your task began',
    );

    const settledInstruction = buildSandboxInstruction(
      false,
      environmentConfig,
      { backgroundEnvironmentSetupPending: false },
    );

    expect(settledInstruction).not.toContain(
      'Automatic Docker project startup may still be building images',
    );
    expect(settledInstruction).not.toContain(
      're-read `.roomote/setup-status.json` every 10-15 seconds',
    );
  });

  it('does not leak non-whitelisted or secret fields into the serialized JSON block', () => {
    const environmentConfig: EnvironmentConfig = {
      name: 'Sandbox',
      description: 'Test environment',
      initialUrl: 'http://127.0.0.1:3000/auth/dev-login',
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/auth/dev-login',
          primary: true,
        },
      ],
      agentInstructions: 'Open the preview first',
      tool_versions: {
        node: '22.14.0',
      },
      env: {
        ROOT_SECRET: 'root-secret',
      },
      auth_bypass_header: 'top-secret-bypass',
      repositories: [
        {
          repository: 'owner/repo',
          commands: [
            {
              name: 'Start app',
              run: 'pnpm dev',
              timeout: 600,
              continue_on_error: false,
              detached: true,
              env: {
                API_KEY: 'super-secret-value',
              },
            },
          ],
        },
      ],
    };

    const instruction = buildSandboxInstruction(true, environmentConfig, {
      envVars: {
        ROOMOTE_WEB_HOST: 'https://task-123-web.preview.roomote.run',
        ROOMOTE_AUTH_BYPASS_VALUE: 'runtime-only-bypass',
      },
    });

    expect(instruction).toContain('Environment configuration:');
    expect(instruction).toContain(
      'Repository setup commands from this environment configuration were already executed before your task started.',
    );
    expect(instruction).toContain(
      'Any command marked `detached: true` was started in the background under PM2 supervision. Check its `logfile` and `pm2 status` before starting another copy.',
    );
    expect(instruction).toContain(
      'This environment exposes a sandbox-local browser surface for visual proof captured through the `capture-visual-proof` skill.',
    );
    expect(instruction).toContain(
      "Use the exact hostname and port from the environment configuration's local browser URL for proof capture, preserving `localhost` versus `127.0.0.1` exactly as configured. Use configured external preview URLs only when the public proxy or hostname itself is part of what you need to validate.",
    );
    expect(instruction).not.toContain('super-secret-value');
    expect(instruction).not.toContain('API_KEY');
    expect(instruction).not.toContain('agentInstructions');
    expect(instruction).not.toContain('ROOT_SECRET');
    expect(instruction).not.toContain('top-secret-bypass');
    expect(instruction).not.toContain('runtime-only-bypass');
    expect(instruction).toContain('http://127.0.0.1:3000/auth/dev-login');
    expect(instruction).toContain('Configured external preview URLs:');
    expect(instruction).toContain(
      '- WEB (primary): https://task-123-web.preview.roomote.run/auth/dev-login',
    );
    expect(instruction).toContain(
      'Use these shareable preview URLs when referring to external previews in replies or proof. Do not share raw machine hosts instead.',
    );
    expect(instruction).toContain(
      'The installed `agent-browser` wrapper automatically applies the task-scoped preview authentication cookie before `open`, `goto`, or `navigate`',
    );
    expect(instruction).toContain(
      'Never print, log, or share the bypass credential.',
    );
  });

  it('describes the sandbox browser surface without printing raw service URLs', () => {
    const instruction = buildSandboxInstruction(true, {
      name: 'Sandbox',
      description: 'Test environment',
      repositories: [],
    });
    const renderedInstruction = instruction ?? '';
    const browserSurfaceLine =
      'This environment exposes a sandbox-local browser surface for visual proof captured through the `capture-visual-proof` skill.';
    const localhostProofLine =
      "Use the exact hostname and port from the environment configuration's local browser URL for proof capture, preserving `localhost` versus `127.0.0.1` exactly as configured. Use configured external preview URLs only when the public proxy or hostname itself is part of what you need to validate.";

    expect(renderedInstruction).toContain(browserSurfaceLine);
    expect(renderedInstruction).toContain(localhostProofLine);
    expect(renderedInstruction.indexOf(browserSurfaceLine)).toBeLessThan(
      renderedInstruction.indexOf(localhostProofLine),
    );
    expect(renderedInstruction).not.toContain(
      'https://sandbox-web.preview.roomote.run',
    );
    expect(renderedInstruction).not.toContain('## Active Browser Session');
    expect(renderedInstruction).not.toContain(
      'agent-browser skills get core --full',
    );
  });

  it('always includes the base sandbox context when no extra config is available', () => {
    const instruction = buildSandboxInstruction(false);
    const renderedInstruction = instruction ?? '';

    expect(renderedInstruction).toContain(
      'You are running inside a cloud sandbox. Your filesystem and processes are isolated to this sandbox instance.',
    );
    expect(renderedInstruction).not.toContain('Playwright');
    expect(renderedInstruction).not.toContain('Environment configuration:');
    expect(renderedInstruction).not.toContain('## Active Browser Session');
    expect(renderedInstruction).not.toContain('agent-browser');
  });

  it('encourages necessary system package installs within sandbox boundaries', () => {
    const instruction = buildSandboxInstruction(false) ?? '';

    expect(instruction).toContain('passwordless `sudo`');
    expect(instruction).toContain(
      'When a missing system dependency blocks authorized work and `apt-get` is available',
    );
    expect(instruction).toContain(
      'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y <package>',
    );
    expect(instruction).toContain(
      'These changes affect only this sandbox, not the host, and do not persist to other tasks or production',
    );
    expect(instruction).toContain('avoid unnecessary installs');
  });

  it('only mentions detached background processes when detached commands exist', () => {
    const instruction = buildSandboxInstruction(false, {
      name: 'Sandbox',
      description: 'Test environment',
      repositories: [
        {
          repository: 'owner/repo',
          commands: [
            {
              name: 'Install deps',
              run: 'pnpm install',
              timeout: 600,
              continue_on_error: false,
            },
          ],
        },
      ],
    });
    const renderedInstruction = instruction ?? '';

    expect(renderedInstruction).toContain(
      'Repository setup commands from this environment configuration were already executed before your task started.',
    );
    expect(renderedInstruction).not.toContain(
      'Any command marked `detached: true` was started in the background under PM2 supervision.',
    );
  });

  it('tells the agent setup may still be running when background environment setup is pending', () => {
    const environmentConfig = {
      name: 'Sandbox',
      description: 'Test environment',
      repositories: [
        {
          repository: 'owner/repo',
          commands: [
            {
              name: 'Install deps',
              run: 'pnpm install',
              timeout: 600,
              continue_on_error: false,
            },
          ],
        },
      ],
    };

    const pendingInstruction =
      buildSandboxInstruction(false, environmentConfig, {
        backgroundEnvironmentSetupPending: true,
      }) ?? '';

    expect(pendingInstruction).toContain(
      'runs automatically in the background and may still be executing while you work',
    );
    expect(pendingInstruction).toContain('.roomote/setup-status.json');
    expect(pendingInstruction).toContain('.roomote/setup-logs/');
    expect(pendingInstruction).toContain(
      'wait for it instead of reporting that you are blocked and ending your turn',
    );
    expect(pendingInstruction).toContain(
      're-read `.roomote/setup-status.json` every 10-15 seconds',
    );
    expect(pendingInstruction).toContain(
      'You will also receive an in-session `Environment setup update:` message when background setup finishes',
    );
    expect(pendingInstruction).not.toContain(
      'were already executed before your task started',
    );

    const settledInstruction =
      buildSandboxInstruction(false, environmentConfig, {
        backgroundEnvironmentSetupPending: false,
      }) ?? '';

    expect(settledInstruction).toContain(
      'were already executed before your task started',
    );
    expect(settledInstruction).toContain('.roomote/setup-status.json');
    expect(settledInstruction).not.toContain('Environment setup update:');
  });

  it('omits external preview URLs when configured hosts are unavailable', () => {
    const instruction = buildSandboxInstruction(
      false,
      {
        name: 'Sandbox',
        description: 'Test environment',
        ports: [
          {
            name: 'WEB',
            port: 3000,
            initial_path: '/auth/dev-login',
            primary: true,
          },
        ],
        repositories: [],
      },
      {
        envVars: {},
      },
    );

    expect(instruction).not.toContain('Configured external preview URLs:');
  });

  it('uses dedicated preview URLs for non-proxied hosts', () => {
    const instruction = buildSandboxInstruction(
      false,
      {
        name: 'Sandbox',
        description: 'Test environment',
        ports: [
          {
            name: 'WEB',
            port: 3000,
            initial_path: '/auth/dev-login',
            primary: true,
            proxied: false,
          },
          {
            name: 'API',
            port: 4000,
            initial_path: '/trpc',
            proxied: true,
          },
        ],
        repositories: [],
      },
      {
        envVars: {
          ROOMOTE_WEB_HOST: 'https://sandbox-raw-host.modal.host',
          ROOMOTE_WEB_PREVIEW_URL: 'https://task-123-web.preview.roomote.run',
          ROOMOTE_API_HOST: 'https://task-123-api.preview.roomote.run',
        },
      },
    );

    expect(instruction).toContain('Configured external preview URLs:');
    expect(instruction).toContain(
      '- API: https://task-123-api.preview.roomote.run/trpc',
    );
    expect(instruction).toContain(
      '- WEB (primary): https://task-123-web.preview.roomote.run/auth/dev-login',
    );
    expect(instruction).not.toContain('https://sandbox-raw-host.modal.host');
  });
});
