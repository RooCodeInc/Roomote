import { TaskPayloadKind, type ServiceInfo } from '@roomote/types';

import { ExecutionError } from '../../../command-executor';
import type { StartupLogger } from '../../../logging';
import { WorkspaceManager, type WorkspaceConfig } from '../../../workspace';

const { mockStartServices, mockStartPortProxies, mockListRepositories } =
  vi.hoisted(() => ({
    mockStartServices: vi.fn<() => Promise<ServiceInfo[]>>(),
    mockStartPortProxies: vi
      .fn<
        () => Promise<{
          servers: [];
          stop: () => Promise<void>;
        }>
      >()
      .mockResolvedValue({
        servers: [],
        stop: async () => {},
      }),
    mockListRepositories: vi.fn<() => Promise<Array<{ fullName: string }>>>(),
  }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      listRepositories: () => mockListRepositories(),
    },
  },
}));

vi.mock('../../../services/service-manager', () => {
  class MockServiceManager {
    constructor(
      _cwd: string,
      _env: Record<string, string | undefined>,
      _dataDir?: string,
      _verbose?: boolean,
    ) {}

    async startServices() {
      return mockStartServices();
    }
  }

  return {
    ServiceManager: MockServiceManager,
  };
});

vi.mock('../../../services/port-proxy-service', () => {
  return {
    startPortProxies: mockStartPortProxies,
  };
});

const {
  initializeRepositories,
  initializeSystemServices,
  initializeEnvironmentServices,
  setupOrganizationEnvironment,
} = await import('../workspace');

function createLogger(): StartupLogger {
  return {
    userLog: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    debug: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as StartupLogger;
}

describe('initializeRepositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prepares only the selected repository subset for scoped multi-repo workspaces', async () => {
    const logger = createLogger();
    const configureSpy = vi
      .spyOn(WorkspaceManager.prototype, 'configure')
      .mockResolvedValue(undefined);
    const prepareRepositorySpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (repo) => `/tmp/${repo}`);

    const result = await initializeRepositories(logger, {
      workspace: {
        type: 'repository_set',
        repositories: ['acme/api', 'acme/web'],
      },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(configureSpy).toHaveBeenCalledTimes(1);
    expect(mockListRepositories).not.toHaveBeenCalled();
    expect(prepareRepositorySpy).toHaveBeenCalledTimes(2);
    expect(prepareRepositorySpy).toHaveBeenNthCalledWith(
      1,
      'acme/api',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(prepareRepositorySpy).toHaveBeenNthCalledWith(
      2,
      'acme/web',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(result.usesSharedWorkspaceRoot).toBe(true);
    expect(logger.debug.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'initializeRepositories: configure git (done in ',
      ),
    );
    expect(logger.debug.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'initializeRepositories: prepare acme/api (done in ',
      ),
    );
    expect(logger.debug.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'initializeRepositories: prepare acme/web (done in ',
      ),
    );
  });

  it('resolves repository providers from the map before the scalar fallback', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    const prepareRepositorySpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (repo) => `/tmp/${repo}`);

    await initializeRepositories(createLogger(), {
      workspace: {
        type: 'repository_set',
        repositories: ['acme/github-app', 'acme/gitlab-app'],
      },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
      sourceControlProvider: 'github',
      repositoryProviders: {
        'acme/gitlab-app': 'gitlab',
      },
    });

    expect(prepareRepositorySpy).toHaveBeenCalledWith(
      'acme/github-app',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(prepareRepositorySpy).toHaveBeenCalledWith(
      'acme/gitlab-app',
      undefined,
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
    );
  });

  it('uses a mapped provider for a single-repository workspace', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    const prepareRepositorySpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockResolvedValue('/tmp/acme/app');

    await initializeRepositories(createLogger(), {
      workspace: {
        type: 'repository',
        repository: 'acme/app',
      },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
      repositoryProviders: { 'acme/app': 'gitlab' },
    });

    expect(prepareRepositorySpy).toHaveBeenCalledWith(
      'acme/app',
      undefined,
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
    );
  });

  it('continues scoped multi-repo workspace setup when at least one selected repository prepares successfully', async () => {
    const logger = createLogger();
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    ).mockImplementation(async (repo) => {
      if (repo === 'acme/api') {
        throw new Error('Repository not found: acme/api');
      }

      return `/tmp/${repo}`;
    });

    const result = await initializeRepositories(logger, {
      workspace: {
        type: 'repository_set',
        repositories: ['acme/api', 'acme/web'],
      },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(mockListRepositories).not.toHaveBeenCalled();
    expect(result.workspacePath).toBeTruthy();
    expect(result.repositoryPreparationOutcome).toEqual({
      mode: 'continued',
      workspaceType: 'repository_set',
      totalRepositories: 2,
      preparedRepositoryCount: 1,
      repositories: [
        {
          repository: 'acme/api',
          reason: 'Repository not found: acme/api',
          diagnostics: undefined,
        },
      ],
    });
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipped 1 repository while preparing the repository_set workspace and continued with 1 prepared repository: acme/api',
      ),
    );
  });

  it('continues all-repositories workspace setup when at least one repository prepares successfully', async () => {
    const logger = createLogger();
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    mockListRepositories.mockResolvedValue([
      { fullName: 'acme/api' },
      { fullName: 'acme/web' },
    ]);
    vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    ).mockImplementation(async (repo) => {
      if (repo === 'acme/api') {
        throw new Error('Repository not found: acme/api');
      }

      return `/tmp/${repo}`;
    });

    const result = await initializeRepositories(logger, {
      workspace: {
        type: 'all_repositories',
      },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(mockListRepositories).toHaveBeenCalledTimes(1);
    expect(result.workspacePath).toBeTruthy();
    expect(result.repositoryPreparationOutcome).toEqual({
      mode: 'continued',
      workspaceType: 'all_repositories',
      totalRepositories: 2,
      preparedRepositoryCount: 1,
      repositories: [
        {
          repository: 'acme/api',
          reason: 'Repository not found: acme/api',
          diagnostics: undefined,
        },
      ],
    });
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipped 1 repository while preparing the all-repositories workspace and continued with 1 prepared repository: acme/api',
      ),
    );
  });

  it('applies mapped providers to repositories discovered for all-repositories workspaces', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    mockListRepositories.mockResolvedValue([
      { fullName: 'acme/github-app' },
      { fullName: 'acme/gitlab-app' },
    ]);
    const prepareRepositorySpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (repo) => `/tmp/${repo}`);

    await initializeRepositories(createLogger(), {
      workspace: { type: 'all_repositories' },
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
      repositoryProviders: { 'acme/gitlab-app': 'gitlab' },
    });

    expect(mockListRepositories).toHaveBeenCalledTimes(1);
    expect(prepareRepositorySpy).toHaveBeenCalledWith(
      'acme/github-app',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(prepareRepositorySpy).toHaveBeenCalledWith(
      'acme/gitlab-app',
      undefined,
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
    );
  });

  it('fails all-repositories workspace setup when no repositories can be prepared', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    mockListRepositories.mockResolvedValue([{ fullName: 'acme/api' }]);
    vi.spyOn(WorkspaceManager.prototype, 'prepareRepository').mockRejectedValue(
      new Error('Repository not found: acme/api'),
    );

    await expect(
      initializeRepositories(createLogger(), {
        workspace: {
          type: 'all_repositories',
        },
        envVars: {},
        taskRunType: TaskPayloadKind.StandardTask,
      }),
    ).rejects.toThrow(
      'Failed to prepare 1 workspace repository:\n- acme/api: Repository not found: acme/api',
    );
  });

  it('fails scoped multi-repo workspace setup when no selected repositories can be prepared', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    vi.spyOn(WorkspaceManager.prototype, 'prepareRepository').mockRejectedValue(
      new Error('Repository not found: acme/api'),
    );

    await expect(
      initializeRepositories(createLogger(), {
        workspace: {
          type: 'repository_set',
          repositories: ['acme/api'],
        },
        envVars: {},
        taskRunType: TaskPayloadKind.StandardTask,
      }),
    ).rejects.toThrow(
      'Failed to prepare 1 workspace repository:\n- acme/api: Repository not found: acme/api',
    );

    expect(mockListRepositories).not.toHaveBeenCalled();
  });

  it('wraps single-repository preparation failures with structured repository diagnostics', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    vi.spyOn(WorkspaceManager.prototype, 'prepareRepository').mockRejectedValue(
      new ExecutionError('Command failed with exit code 128', {
        command: {
          name: 'Git clone',
          run: 'git clone https://github.com/acme/api.git',
          timeout: 300,
          continue_on_error: false,
        },
        success: false,
        duration: 2,
        exitCode: 128,
        stdout: '',
        stderr:
          "remote: Repository not found.\nfatal: repository 'https://github.com/acme/api.git/' not found",
        error: 'Command failed with exit code 128',
      }),
    );

    await expect(
      initializeRepositories(createLogger(), {
        workspace: {
          type: 'repository',
          repository: 'acme/api',
        },
        envVars: {},
        taskRunType: TaskPayloadKind.StandardTask,
      }),
    ).rejects.toMatchObject({
      failure: {
        mode: 'fatal',
        workspaceType: 'repository',
        totalRepositories: 1,
        preparedRepositoryCount: 0,
        repositories: [
          expect.objectContaining({
            repository: 'acme/api',
            reason: 'Command failed with exit code 128',
            diagnostics: expect.stringContaining(
              'remote: Repository not found.',
            ),
          }),
        ],
      },
    });
  });

  it('installs root-level tool versions for environment workspaces at the shared workspace root', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      WorkspaceManager.prototype,
      'prepareEnvironmentRepositories',
    ).mockResolvedValue({
      repoPaths: {
        'acme/api': '/tmp/acme/api',
        'acme/web': '/tmp/acme/web',
      },
    });
    const installWorkspaceToolVersionsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'installWorkspaceToolVersions')
      .mockResolvedValue(undefined);

    const result = await initializeRepositories(createLogger(), {
      workspace: {
        type: 'environment',
        environmentId: 'env_123',
        environmentConfig: {
          name: 'Test Environment',
          repositories: [
            { repository: 'acme/api' },
            { repository: 'acme/web' },
          ],
          tool_versions: {
            node: '22.14.0',
          },
        },
      } as WorkspaceConfig,
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(installWorkspaceToolVersionsSpy).toHaveBeenCalledWith({
      node: '22.14.0',
    });
    expect(result.usesSharedWorkspaceRoot).toBe(true);
  });

  it('enables legacy-path cleanup only for snapshot environment preparation', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    const prepareEnvironmentRepositoriesSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareEnvironmentRepositories')
      .mockResolvedValue({
        repoPaths: {
          'acme/api': '/tmp/acme/api',
        },
      });
    vi.spyOn(
      WorkspaceManager.prototype,
      'installWorkspaceToolVersions',
    ).mockResolvedValue(undefined);

    await initializeRepositories(createLogger(), {
      workspace: {
        type: 'environment',
        environmentId: 'env_123',
        environmentConfig: {
          name: 'Snapshot Environment',
          repositories: [{ repository: 'acme/api' }],
        },
      } as WorkspaceConfig,
      envVars: {},
      taskRunType: TaskPayloadKind.SnapshotEnvironment,
      cleanupLegacyPaths: true,
    });

    expect(prepareEnvironmentRepositoriesSpy).toHaveBeenCalledWith(
      {
        name: 'Snapshot Environment',
        repositories: [{ repository: 'acme/api' }],
      },
      false,
      true,
      {
        sourceRepo: undefined,
        sourceBranch: undefined,
        sourceSha: undefined,
      },
      {},
    );
  });

  it('passes repository provider overrides to environment preparation', async () => {
    vi.spyOn(WorkspaceManager.prototype, 'configure').mockResolvedValue(
      undefined,
    );
    const prepareEnvironmentRepositoriesSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareEnvironmentRepositories')
      .mockResolvedValue({ repoPaths: {} });
    vi.spyOn(
      WorkspaceManager.prototype,
      'installWorkspaceToolVersions',
    ).mockResolvedValue(undefined);

    await initializeRepositories(createLogger(), {
      workspace: {
        type: 'environment',
        environmentId: 'env_123',
        environmentConfig: {
          name: 'Mixed Providers',
          repositories: [
            { repository: 'acme/github-app' },
            { repository: 'acme/gitlab-app' },
          ],
        },
      } as WorkspaceConfig,
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
      sourceControlProvider: 'github',
      repositoryProviders: {
        'acme/gitlab-app': 'gitlab',
      },
    });

    expect(prepareEnvironmentRepositoriesSpy).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      false,
      expect.any(Object),
      {
        repositoryProviders: { 'acme/gitlab-app': 'gitlab' },
      },
    );
  });
});

describe('initializeSystemServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not inject service connection env vars into command env', async () => {
    mockStartServices.mockResolvedValue([
      {
        name: 'postgres17',
        port: 5432,
        host: 'localhost',
        connectionString: 'postgresql://postgres@localhost:5432/postgres',
        envVars: {
          DATABASE_URL: 'postgresql://postgres@localhost:5432/postgres',
          POSTGRES_HOST: 'localhost',
          POSTGRES_PORT: '5432',
        },
      },
    ]);

    const envVars: Record<string, string | undefined> = {
      EXISTING_ENV: 'keep-me',
    };

    const workspace = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [{ repository: 'owner/repo' }],
        services: ['postgres17'],
      },
    } as WorkspaceConfig;

    const result = await initializeSystemServices(createLogger(), {
      workspace,
      envVars,
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(mockStartServices).toHaveBeenCalledTimes(1);
    expect(result.services).toHaveLength(1);
    expect(result.env.EXISTING_ENV).toBe('keep-me');
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.env.POSTGRES_HOST).toBeUndefined();
    expect(envVars.DATABASE_URL).toBeUndefined();
    expect(envVars.POSTGRES_HOST).toBeUndefined();
  });

  it('injects AWS web identity env vars from environment OIDC config', async () => {
    const envVars: Record<string, string | undefined> = {};

    const workspace = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [{ repository: 'owner/repo' }],
        oidc: {
          aws: {
            role_arn: 'arn:aws:iam::123456789012:role/example',
            token_file: '/home/roomote/.roomote/oidc/aws/token',
            region: 'us-east-1',
          },
        },
      },
    } as WorkspaceConfig;

    await initializeSystemServices(createLogger(), {
      workspace,
      envVars,
      taskRunType: TaskPayloadKind.StandardTask,
    });

    expect(envVars.AWS_WEB_IDENTITY_TOKEN_FILE).toBe(
      '/home/roomote/.roomote/oidc/aws/token',
    );
    expect(envVars.AWS_ROLE_ARN).toBe('arn:aws:iam::123456789012:role/example');
    expect(envVars.AWS_REGION).toBe('us-east-1');
    expect(envVars.AWS_DEFAULT_REGION).toBe('us-east-1');
  });
});

describe('initializeEnvironmentServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes per-port proxy routing settings through when starting port proxies', async () => {
    const workspace = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [{ repository: 'owner/repo' }],
      },
    } as WorkspaceConfig;

    const unauthenticatedPorts = new Set(['PUBLIC']);
    const wildcardPrefixPorts = new Set(['PREVIEW']);

    await initializeEnvironmentServices(createLogger(), {
      workspace,
      envVars: {},
      taskRunType: TaskPayloadKind.StandardTask,
      serviceContext: {
        taskId: 'task_123',
        publicKey: 'base64-public-key',
        proxyPorts: { DASHBOARD: 49152 },
        appPorts: { DASHBOARD: 3000 },
        unauthenticatedPorts,
        subdomains: { DASHBOARD: 'dashboard.pocketflows' },
        wildcardPrefixPorts,
        authCookieName: 'preview_auth_nested',
        authBypassPaths: { DASHBOARD: ['/health'] },
        authBypassHeaderValue: 'bypass-token',
        authBypassHeaderName: 'x-roomote-bypass',
      } as never,
    });

    expect(mockStartPortProxies).toHaveBeenCalledWith({
      proxyPorts: { DASHBOARD: 49152 },
      appPorts: { DASHBOARD: 3000 },
      taskId: 'task_123',
      publicKey: 'base64-public-key',
      unauthenticatedPorts,
      subdomains: { DASHBOARD: 'dashboard.pocketflows' },
      wildcardPrefixPorts,
      authCookieName: 'preview_auth_nested',
      authBypassPaths: { DASHBOARD: ['/health'] },
      authBypassHeaderValue: 'bypass-token',
      authBypassHeaderName: 'x-roomote-bypass',
    });
  });
});

describe('setupOrganizationEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs environment skills before running repository commands', async () => {
    const installSkillsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'installEnvironmentSkills')
      .mockResolvedValue(undefined);
    const installManualSkillsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'installManualEnvironmentSkills')
      .mockResolvedValue(undefined);
    const executeRepoCommandsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'executeEnvironmentRepositoryCommands')
      .mockResolvedValue(undefined);

    const workspace: Extract<WorkspaceConfig, { type: 'environment' }> = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [{ repository: 'owner/repo' }],
        skills: {
          'vercel-labs/agent-skills': ['web-design-guidelines'],
        },
        manualSkills: [
          {
            name: 'my-manual-skill',
            description: 'Adds a custom skill.',
            content: '# My Manual Skill\n',
          },
        ],
      },
    };

    await setupOrganizationEnvironment(createLogger(), {
      environment: workspace,
      envVars: {},
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        environment: {
          repoPaths: {
            'owner/repo': '/tmp/workspace/owner/repo',
          },
        },
      },
    });

    expect(installSkillsSpy).toHaveBeenCalledWith({
      'vercel-labs/agent-skills': ['web-design-guidelines'],
    });
    expect(installManualSkillsSpy).toHaveBeenCalledWith([
      {
        name: 'my-manual-skill',
        description: 'Adds a custom skill.',
        content: '# My Manual Skill\n',
      },
    ]);
    expect(executeRepoCommandsSpy).toHaveBeenCalledWith(
      workspace.environmentConfig.repositories,
      { 'owner/repo': '/tmp/workspace/owner/repo' },
      undefined,
      {
        continueOnError: true,
        onCommandStart: expect.any(Function),
        onCommandResult: expect.any(Function),
        onCommandFailure: expect.any(Function),
      },
    );
    const installCallOrder = installSkillsSpy.mock.invocationCallOrder.at(0);
    const installManualCallOrder =
      installManualSkillsSpy.mock.invocationCallOrder.at(0);
    const executeCallOrder =
      executeRepoCommandsSpy.mock.invocationCallOrder.at(0);

    expect(installCallOrder).toBeDefined();
    expect(installManualCallOrder).toBeDefined();
    expect(executeCallOrder).toBeDefined();

    if (installCallOrder !== undefined && executeCallOrder !== undefined) {
      expect(installCallOrder).toBeLessThan(executeCallOrder);
    }

    if (
      installManualCallOrder !== undefined &&
      executeCallOrder !== undefined
    ) {
      expect(installManualCallOrder).toBeLessThan(executeCallOrder);
    }
  });

  it('warns and continues when snapshot resume repository commands fail', async () => {
    vi.spyOn(
      WorkspaceManager.prototype,
      'installEnvironmentSkills',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      WorkspaceManager.prototype,
      'installManualEnvironmentSkills',
    ).mockResolvedValue(undefined);
    const executeRepoCommandsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'executeEnvironmentRepositoryCommands')
      .mockImplementation(
        async (_repositories, _repoPaths, _userEnvVars, options) => {
          options?.onCommandFailure?.({
            repository: 'owner/repo',
            result: {
              command: {
                name: 'Build backend',
                run: 'pnpm build',
                timeout: 600,
                continue_on_error: true,
              },
              success: false,
              duration: 50,
              exitCode: 2,
              stdout: 'Build output',
              stderr: 'Type error',
              error: 'Command failed with exit code 2',
            },
          });
        },
      );
    const logger = createLogger();
    const workspace: Extract<WorkspaceConfig, { type: 'environment' }> = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [
          {
            repository: 'owner/repo',
            commands: [
              {
                name: 'Build backend',
                run: 'pnpm build',
                timeout: 600,
                continue_on_error: false,
              },
            ],
          },
        ],
      },
    };

    const warnings = await setupOrganizationEnvironment(logger, {
      environment: workspace,
      envVars: {},
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        environment: {
          repoPaths: {
            repo: '/tmp/workspace/repo',
          },
        },
      },
      continueRepositoryCommandFailures: true,
    });

    expect(executeRepoCommandsSpy).toHaveBeenCalledWith(
      workspace.environmentConfig.repositories,
      { repo: '/tmp/workspace/repo' },
      undefined,
      {
        continueOnError: true,
        onCommandStart: expect.any(Function),
        onCommandResult: expect.any(Function),
        onCommandFailure: expect.any(Function),
      },
    );
    expect(warnings).toEqual([
      {
        message:
          'Optional environment command "Build backend" failed for owner/repo: Command failed with exit code 2',
      },
    ]);
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      'Optional environment command "Build backend" failed for owner/repo: Command failed with exit code 2 Continuing without a fully configured environment.',
    );
    expect(logger.debug.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Environment command "Build backend" failed during environment setup:',
      ),
    );
    expect(logger.debug.warn).toHaveBeenCalledWith(
      expect.stringContaining('stdout -> Build output'),
    );
    expect(logger.debug.warn).toHaveBeenCalledWith(
      expect.stringContaining('stderr -> Type error'),
    );
  });

  it('treats environment repository command failures as optional warnings', async () => {
    vi.spyOn(
      WorkspaceManager.prototype,
      'installEnvironmentSkills',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      WorkspaceManager.prototype,
      'installManualEnvironmentSkills',
    ).mockResolvedValue(undefined);
    const executeRepoCommandsSpy = vi
      .spyOn(WorkspaceManager.prototype, 'executeEnvironmentRepositoryCommands')
      .mockImplementation(
        async (_repositories, _repoPaths, _userEnvVars, options) => {
          options?.onCommandFailure?.({
            repository: 'owner/repo',
            result: {
              command: {
                name: 'Build backend',
                run: 'pnpm build',
                timeout: 600,
                continue_on_error: false,
              },
              success: false,
              duration: 50,
              exitCode: 2,
              stdout: 'Build output',
              stderr: 'Type error',
              error: 'Command failed with exit code 2',
            },
          });
        },
      );
    const workspace: Extract<WorkspaceConfig, { type: 'environment' }> = {
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'Test Environment',
        repositories: [
          {
            repository: 'owner/repo',
            commands: [
              {
                name: 'Build backend',
                run: 'pnpm build',
                timeout: 600,
                continue_on_error: false,
              },
            ],
          },
        ],
      },
    };

    const logger = createLogger();

    await expect(
      setupOrganizationEnvironment(logger, {
        environment: workspace,
        envVars: {},
        preparedWorkspace: {
          workspacePath: '/tmp/workspace',
          environment: {
            repoPaths: {
              repo: '/tmp/workspace/repo',
            },
          },
        },
        continueRepositoryCommandFailures: true,
      }),
    ).resolves.toEqual([
      {
        message:
          'Optional environment command "Build backend" failed for owner/repo: Command failed with exit code 2',
      },
    ]);

    expect(executeRepoCommandsSpy).toHaveBeenCalledWith(
      workspace.environmentConfig.repositories,
      { repo: '/tmp/workspace/repo' },
      undefined,
      {
        continueOnError: true,
        onCommandStart: expect.any(Function),
        onCommandResult: expect.any(Function),
        onCommandFailure: expect.any(Function),
      },
    );
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      'Optional environment command "Build backend" failed for owner/repo: Command failed with exit code 2 Continuing without a fully configured environment.',
    );
  });
});
