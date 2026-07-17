// pnpm --filter @roomote/worker test src/workspace/__tests__/tool-versions.test.ts

import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { sdk } from '@roomote/sdk/client';
import { COMMAND_DEFAULT_TIMEOUT } from '@roomote/types';

import { WorkspaceManager } from '../workspace-manager';

const { mockExecute, mockExecuteAll } = vi.hoisted(() => ({
  mockExecute: vi.fn().mockResolvedValue({ success: true, stdout: '{}' }),
  mockExecuteAll: vi.fn().mockResolvedValue([]),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue('/workspace/.roomote-manual-skills-test'),
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../command-executor', () => ({
  CommandExecutor: vi.fn().mockImplementation(function () {
    return {
      execute: mockExecute,
      executeAll: mockExecuteAll,
    };
  }),
  ExecutionError: class ExecutionError extends Error {
    formatDetails() {
      return this.message;
    }
  },
}));

vi.mock('../../lib/github-token', () => ({
  ensureGitCredentialHelper: vi
    .fn()
    .mockReturnValue('/tmp/git-credential-roomote.sh'),
  SOURCE_CONTROL_GIT_CONFIG_PATH: '/tmp/source-control-gitconfig',
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: vi.fn(),
    },
  },
}));

vi.mock('../../services', () => ({
  ServiceManager: vi.fn(),
  getServiceDefinition: vi.fn(),
}));

vi.mock('../../services/port-proxy-service', () => ({
  startPortProxies: vi.fn(),
}));

const RESET_LOCAL_CHANGES_COMMAND =
  'if git rev-parse --verify HEAD >/dev/null 2>&1; then git reset --hard HEAD; fi';

function buildRepositorySyncCommands(
  branch: string,
  options: {
    setDefaultRemote?: boolean;
  } = {},
) {
  const { setDefaultRemote = true } = options;

  return [
    {
      name: 'Git reset local changes',
      run: RESET_LOCAL_CHANGES_COMMAND,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git clean untracked',
      run: 'git clean -fd',
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git checkout branch',
      run: `git checkout -B '${branch}' 'origin/${branch}'`,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git reset to remote',
      run: `git reset --hard 'origin/${branch}'`,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    ...(setDefaultRemote
      ? [
          {
            name: 'Set default remote repo.',
            run: "gh repo set-default 'acme/backend'",
            timeout: 60,
            continue_on_error: true,
          },
        ]
      : []),
  ];
}

/**
 * Access private methods for focused unit testing.
 */
function getPrivateMethod<T>(instance: WorkspaceManager, method: string): T {
  return (instance as unknown as Record<string, unknown>)[method] as T;
}

describe('WorkspaceManager tool versions', () => {
  const workspaceRoot = '/workspace';
  const repoPath = '/workspace/backend';

  let manager: WorkspaceManager;
  let installToolVersions: (
    repoPath: string,
    toolVersionsConfig?: Record<string, string>,
  ) => Promise<void>;
  let addToGitExclude: (repoPath: string, pattern: string) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockReset().mockResolvedValue({ success: true, stdout: '{}' });
    mockExecuteAll.mockReset().mockResolvedValue([]);
    manager = new WorkspaceManager(workspaceRoot, {} as NodeJS.ProcessEnv);
    installToolVersions = getPrivateMethod(manager, 'installToolVersions');
    addToGitExclude = getPrivateMethod(manager, 'addToGitExclude');

    // Bind to the instance so `this` works correctly.
    installToolVersions = installToolVersions.bind(manager);
    addToGitExclude = addToGitExclude.bind(manager);
  });

  describe('installToolVersions', () => {
    it('should generate repo-local fallback config from repo tool_versions and add it to .git/info/exclude', async () => {
      const config = { node: '20.11.0', python: '3.12.1' };

      vi.mocked(existsSync).mockImplementation(
        (path) => path === join(repoPath, 'mise.local.toml'),
      );
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (path === join(repoPath, 'mise.local.toml')) {
          throw new Error('ENOENT');
        }

        return '';
      });

      await installToolVersions(repoPath, config);

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, 'mise.local.toml'),
        expect.stringContaining(
          '[tools]\nnode = "20.11.0"\npython = "3.12.1"\n',
        ),
        'utf-8',
      );

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, '.git', 'info', 'exclude'),
        'mise.local.toml\n',
        'utf-8',
      );
    });

    it('should keep repo .tool-versions entries and only add missing env fallback tools', async () => {
      const config = { node: '24.12.0', python: '3.12.1', pnpm: '10.29.3' };

      vi.mocked(existsSync).mockImplementation(
        (path) => path === join(repoPath, '.tool-versions'),
      );
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (path === join(repoPath, '.tool-versions')) {
          return 'node 22.14.0\n';
        }

        return '';
      });

      await installToolVersions(repoPath, config);

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, 'mise.local.toml'),
        expect.stringContaining(
          '[tools]\npython = "3.12.1"\npnpm = "10.29.3"\n',
        ),
        'utf-8',
      );
      expect(writeFile).not.toHaveBeenCalledWith(
        join(repoPath, '.tool-versions'),
        expect.any(String),
        'utf-8',
      );
    });

    it('should use existing .tool-versions when no config is provided', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      await installToolVersions(repoPath);

      // Should NOT write a new .tool-versions file.
      expect(writeFile).not.toHaveBeenCalledWith(
        join(repoPath, '.tool-versions'),
        expect.any(String),
        expect.any(String),
      );
    });

    it('should return early when no config and no .tool-versions exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await installToolVersions(repoPath);

      // Should not write any files or call mise.
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should treat empty config object as not provided', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await installToolVersions(repoPath, {});

      // Empty config is treated as "no config" -- no file exists, so return early.
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should remove stale generated repo fallback config when repo .tool-versions now covers those tools', async () => {
      const config = { node: '20.11.0' };

      vi.mocked(existsSync).mockImplementation(
        (path) =>
          path === join(repoPath, '.tool-versions') ||
          path === join(repoPath, 'mise.local.toml'),
      );
      vi.mocked(readFile).mockImplementation(async (path) => {
        if (path === join(repoPath, '.tool-versions')) {
          return 'node 22.14.0\n';
        }

        if (path === join(repoPath, 'mise.local.toml')) {
          return '# Generated by Roomote. Repository-owned tool config wins; these entries only fill missing tools.\n\n[tools]\nnode = "20.11.0"\n';
        }

        return '';
      });

      await installToolVersions(repoPath, config);

      expect(rm).toHaveBeenCalledWith(join(repoPath, 'mise.local.toml'), {
        force: true,
      });
      expect(writeFile).not.toHaveBeenCalledWith(
        join(repoPath, 'mise.local.toml'),
        expect.any(String),
        'utf-8',
      );
    });
  });

  describe('prepareRepository', () => {
    it('clones repositories with git transport instead of gh repo clone', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
      );

      expect(mkdir).toHaveBeenCalledWith('/workspace/acme', {
        recursive: true,
      });
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git clone',
        run: "git clone 'https://github.com/acme/backend.git' 'acme/backend'",
        retries: 4,
        timeout: 300,
        continue_on_error: false,
      });
    });

    it('clones GitLab repositories from gitlab.com without requiring synced repository metadata', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue(undefined);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
        false,
        {
          sourceControlProvider: 'gitlab',
        },
      );

      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git clone',
        run: "git clone 'https://gitlab.com/acme/backend.git' 'acme/backend'",
        retries: 4,
        timeout: 300,
        continue_on_error: false,
      });
    });

    it('does not set gh as the default remote for GitLab repositories', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue(undefined);

      await manager.prepareRepository(
        'acme/backend',
        'main',
        undefined,
        false,
        false,
        {
          sourceControlProvider: 'gitlab',
        },
      );

      expect(mockExecuteAll).toHaveBeenCalledWith(
        buildRepositorySyncCommands('main', { setDefaultRemote: false }),
      );
    });

    it('clones Gitea repositories from synced repository metadata', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
        cloneUrl: 'https://git.example.com/acme/backend.git',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
        false,
        {
          sourceControlProvider: 'gitea',
        },
      );

      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git clone',
        run: "git clone 'https://git.example.com/acme/backend.git' 'acme/backend'",
        retries: 4,
        timeout: 300,
        continue_on_error: false,
      });
    });

    it('requires synced repository metadata for Gitea repositories', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue(undefined);

      await expect(
        manager.prepareRepository(
          'acme/backend',
          undefined,
          undefined,
          true,
          false,
          {
            sourceControlProvider: 'gitea',
          },
        ),
      ).rejects.toThrow('Repository not found: acme/backend');
    });

    it('clones Azure DevOps repositories from synced repository metadata', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/Platform/backend',
        defaultBranch: 'main',
        cloneUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      } as never);

      await manager.prepareRepository(
        'acme/Platform/backend',
        undefined,
        undefined,
        true,
        false,
        {
          sourceControlProvider: 'ado',
        },
      );

      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git clone',
        run: "git clone 'https://dev.azure.com/acme/Platform/_git/backend' 'acme/Platform/backend'",
        retries: 4,
        timeout: 300,
        continue_on_error: false,
      });
    });

    it('requires synced repository metadata for Azure DevOps repositories', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue(undefined);

      await expect(
        manager.prepareRepository(
          'acme/Platform/backend',
          undefined,
          undefined,
          true,
          false,
          {
            sourceControlProvider: 'ado',
          },
        ),
      ).rejects.toThrow('Repository not found: acme/Platform/backend');
    });

    it('keeps explicitly requested default branches untouched', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository('acme/backend', 'main', undefined, false);

      expect(mockExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Git resolve remote HEAD',
        }),
      );
      expect(mockExecuteAll).toHaveBeenCalledWith(
        buildRepositorySyncCommands('main'),
      );
    });

    it('uses the resolved remote HEAD when the requested branch is blank', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);
      mockExecute.mockImplementation(async (command) => {
        if (command.name === 'Git resolve remote HEAD') {
          return {
            success: true,
            stdout:
              'ref: refs/heads/trunk\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n',
          };
        }

        return {
          success: true,
          stdout: '',
        };
      });

      await manager.prepareRepository('acme/backend', '', undefined, false);

      expect(mockExecuteAll).toHaveBeenCalledWith(
        buildRepositorySyncCommands('trunk'),
      );
    });

    it('keeps explicitly requested non-default branches untouched', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        'release/1.0',
        undefined,
        false,
      );

      expect(mockExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Git resolve remote HEAD',
        }),
      );
      expect(mockExecuteAll).toHaveBeenCalledWith(
        buildRepositorySyncCommands('release/1.0'),
      );
    });

    it('marks reused repositories as safe before running git operations', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
      );

      expect(mockExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Git clone',
        }),
      );

      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/acme/backend' >/dev/null || git config --global --add safe.directory '/workspace/acme/backend'",
        timeout: 60,
        continue_on_error: true,
      });
    });

    it('reuses legacy snapshot clone paths during preserveGitState resumes', async () => {
      vi.mocked(existsSync).mockImplementation(
        (targetPath) => targetPath === '/workspace/backend',
      );

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
      );

      expect(mkdir).not.toHaveBeenCalledWith('/workspace/acme', {
        recursive: true,
      });
      expect(mockExecute).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Git clone',
        }),
      );
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/backend' >/dev/null || git config --global --add safe.directory '/workspace/backend'",
        timeout: 60,
        continue_on_error: true,
      });
    });

    it('keeps the legacy bare-name path during fresh prepares by default', async () => {
      vi.mocked(existsSync).mockImplementation(
        (targetPath) =>
          targetPath === '/workspace/acme/backend' ||
          targetPath === '/workspace/backend',
      );

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        false,
      );

      expect(rm).not.toHaveBeenCalledWith('/workspace/backend', {
        recursive: true,
        force: true,
      });
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/acme/backend' >/dev/null || git config --global --add safe.directory '/workspace/acme/backend'",
        timeout: 60,
        continue_on_error: true,
      });
    });

    it('removes the legacy bare-name path when cleanupLegacyPaths is enabled', async () => {
      vi.mocked(existsSync).mockImplementation(
        (targetPath) =>
          targetPath === '/workspace/acme/backend' ||
          targetPath === '/workspace/backend',
      );

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        false,
        true,
      );

      expect(rm).toHaveBeenCalledWith('/workspace/backend', {
        recursive: true,
        force: true,
      });
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/acme/backend' >/dev/null || git config --global --add safe.directory '/workspace/acme/backend'",
        timeout: 60,
        continue_on_error: true,
      });
    });

    it('keeps the legacy bare-name path during preserveGitState resumes', async () => {
      vi.mocked(existsSync).mockImplementation(
        (targetPath) =>
          targetPath === '/workspace/acme/backend' ||
          targetPath === '/workspace/backend',
      );

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/backend',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/backend',
        undefined,
        undefined,
        true,
      );

      expect(rm).not.toHaveBeenCalledWith('/workspace/backend', {
        recursive: true,
        force: true,
      });
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/acme/backend' >/dev/null || git config --global --add safe.directory '/workspace/acme/backend'",
        timeout: 60,
        continue_on_error: true,
      });
    });

    it('does not remove the canonical checkout when the org and repo names match', async () => {
      vi.mocked(existsSync).mockImplementation(
        (targetPath) =>
          targetPath === '/workspace/acme/acme' ||
          targetPath === '/workspace/acme',
      );

      vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
        fullName: 'acme/acme',
        defaultBranch: 'main',
      } as never);

      await manager.prepareRepository(
        'acme/acme',
        undefined,
        undefined,
        false,
        true,
      );

      expect(rm).not.toHaveBeenCalledWith('/workspace/acme', {
        recursive: true,
        force: true,
      });
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Git safe directory',
        run: "git config --global --get-all safe.directory | grep -Fx -- '/workspace/acme/acme' >/dev/null || git config --global --add safe.directory '/workspace/acme/acme'",
        timeout: 60,
        continue_on_error: true,
      });
    });
  });

  describe('configure', () => {
    it('configures git without requiring a separate gh auth status preflight', async () => {
      await manager.configure();

      expect(mockExecuteAll).toHaveBeenCalledWith([
        {
          name: 'GitHub auth setup-git',
          run: 'if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git; else echo "Skipping gh auth setup-git because GH_TOKEN is not set"; fi',
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'GitHub credential helper (file-backed)',
          run: "git config --global --replace-all credential.https://github.com.helper '!/tmp/git-credential-roomote.sh'",
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'GitLab credential helper (file-backed)',
          run: "git config --global --replace-all credential.https://gitlab.com.helper '!/tmp/git-credential-roomote.sh'",
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'GitLab credential useHttpPath',
          run: 'git config --global credential.https://gitlab.com.useHttpPath true',
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'Source-control credential helper (file-backed)',
          run: "git config --global --replace-all credential.helper '!/tmp/git-credential-roomote.sh'",
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'Source-control credential useHttpPath',
          run: 'git config --global credential.useHttpPath true',
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'Source-control auth include file',
          run: "git config --global --get-all include.path | grep -Fx -- '/tmp/source-control-gitconfig' >/dev/null || git config --global --add include.path '/tmp/source-control-gitconfig'",
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'Git config email',
          run: "git config --global user.email 'roomote@roomote.dev'",
          timeout: 60,
          continue_on_error: false,
        },
        {
          name: 'Git config name',
          run: "git config --global user.name 'Roomote'",
          timeout: 60,
          continue_on_error: false,
        },
      ]);
    });
  });

  describe('prepareEnvironmentRepositories', () => {
    it('wraps environment repository failures in a structured preparation error', async () => {
      vi.spyOn(manager, 'prepareRepository').mockImplementation(
        async (repository) => {
          if (repository === 'acme/api') {
            throw new Error('Repository not found: acme/api');
          }

          return `/workspace/${repository}`;
        },
      );

      await expect(
        manager.prepareEnvironmentRepositories({
          name: 'Test Environment',
          repositories: [
            { repository: 'acme/api' },
            { repository: 'acme/web' },
          ],
        }),
      ).rejects.toMatchObject({
        failure: {
          mode: 'fatal',
          workspaceType: 'environment',
          totalRepositories: 2,
          preparedRepositoryCount: 1,
          repositories: [
            {
              repository: 'acme/api',
              reason: 'Repository not found: acme/api',
            },
          ],
        },
      });
    });

    it('preserves blank source branches when the environment repo does not pin a branch', async () => {
      const prepareRepositorySpy = vi
        .spyOn(manager, 'prepareRepository')
        .mockResolvedValue('/workspace/acme/api');

      await manager.prepareEnvironmentRepositories(
        {
          name: 'Test Environment',
          repositories: [{ repository: 'acme/api' }],
        },
        false,
        false,
        {
          sourceRepo: 'acme/api',
          sourceBranch: '',
        },
      );

      expect(prepareRepositorySpy).toHaveBeenCalledWith(
        'acme/api',
        '',
        undefined,
        false,
        false,
        {
          setDefaultRemote: false,
          toolVersionsConfig: undefined,
        },
      );
    });

    it('keeps an explicit environment repo branch when the source branch is blank', async () => {
      const prepareRepositorySpy = vi
        .spyOn(manager, 'prepareRepository')
        .mockResolvedValue('/workspace/acme/api');

      await manager.prepareEnvironmentRepositories(
        {
          name: 'Test Environment',
          repositories: [{ repository: 'acme/api', branch: 'release/1.0' }],
        },
        false,
        false,
        {
          sourceRepo: 'acme/api',
          sourceBranch: '',
        },
      );

      expect(prepareRepositorySpy).toHaveBeenCalledWith(
        'acme/api',
        'release/1.0',
        undefined,
        false,
        false,
        {
          setDefaultRemote: false,
          toolVersionsConfig: undefined,
        },
      );
    });
  });

  describe('installWorkspaceToolVersions', () => {
    it('should write shared workspace tool versions without touching git excludes', async () => {
      vi.mocked(readFile).mockResolvedValue('');

      await manager.installWorkspaceToolVersions({ node: '22.14.0' });

      expect(writeFile).toHaveBeenCalledWith(
        join(workspaceRoot, '.tool-versions'),
        'node 22.14.0\n',
        'utf-8',
      );
      expect(writeFile).not.toHaveBeenCalledWith(
        join(workspaceRoot, '.git', 'info', 'exclude'),
        expect.any(String),
        'utf-8',
      );
    });

    it('should leave the workspace root .tool-versions untouched when config is omitted', async () => {
      await manager.installWorkspaceToolVersions();

      expect(writeFile).not.toHaveBeenCalledWith(
        join(workspaceRoot, '.tool-versions'),
        expect.any(String),
        'utf-8',
      );
    });
  });

  describe('addToGitExclude', () => {
    it('should append pattern to empty exclude file', async () => {
      vi.mocked(readFile).mockResolvedValue('');

      await addToGitExclude(repoPath, '.tool-versions');

      expect(mkdir).toHaveBeenCalledWith(join(repoPath, '.git', 'info'), {
        recursive: true,
      });

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, '.git', 'info', 'exclude'),
        '.tool-versions\n',
        'utf-8',
      );
    });

    it('should append pattern to existing exclude file with trailing newline', async () => {
      vi.mocked(readFile).mockResolvedValue('*.log\n');

      await addToGitExclude(repoPath, '.tool-versions');

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, '.git', 'info', 'exclude'),
        '*.log\n.tool-versions\n',
        'utf-8',
      );
    });

    it('should append pattern to existing exclude file without trailing newline', async () => {
      vi.mocked(readFile).mockResolvedValue('*.log');

      await addToGitExclude(repoPath, '.tool-versions');

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, '.git', 'info', 'exclude'),
        '*.log\n.tool-versions\n',
        'utf-8',
      );
    });

    it('should not duplicate pattern if already present', async () => {
      vi.mocked(readFile).mockResolvedValue('*.log\n.tool-versions\n');

      await addToGitExclude(repoPath, '.tool-versions');

      // writeFile should NOT be called since pattern is already there.
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('should handle missing exclude file gracefully', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

      await addToGitExclude(repoPath, '.tool-versions');

      expect(writeFile).toHaveBeenCalledWith(
        join(repoPath, '.git', 'info', 'exclude'),
        '.tool-versions\n',
        'utf-8',
      );
    });
  });

  describe('installEnvironmentSkills', () => {
    it('should install each source with unique skill names', async () => {
      await manager.installEnvironmentSkills({
        'vercel-labs/agent-skills': [
          'web-design-guidelines',
          '  web-design-guidelines ',
          'create-pr',
        ],
        'anthropics/skills': ['frontend-design'],
      });

      expect(mockExecuteAll).toHaveBeenCalledTimes(1);

      const [commands] = mockExecuteAll.mock.calls[0] ?? [];

      expect(commands).toEqual([
        {
          name: 'Install skills from vercel-labs/agent-skills',
          run: "npx -y skills add 'vercel-labs/agent-skills' --skill 'web-design-guidelines' --skill 'create-pr' -g -y",
          timeout: 600,
          continue_on_error: true,
        },
        {
          name: 'Install skills from anthropics/skills',
          run: "npx -y skills add 'anthropics/skills' --skill 'frontend-design' -g -y",
          timeout: 600,
          continue_on_error: true,
        },
      ]);
    });

    it('should install all skills from a source when configured with all', async () => {
      await manager.installEnvironmentSkills({
        'dbt-labs/dbt-agent-skills': 'all',
      });

      expect(mockExecuteAll).toHaveBeenCalledTimes(1);

      const [commands] = mockExecuteAll.mock.calls[0] ?? [];

      expect(commands).toEqual([
        {
          name: 'Install skills from dbt-labs/dbt-agent-skills',
          run: "npx -y skills add 'dbt-labs/dbt-agent-skills' -g -y",
          timeout: 600,
          continue_on_error: true,
        },
      ]);
    });

    it('should no-op when no installable skills are provided', async () => {
      await manager.installEnvironmentSkills({});

      expect(mockExecuteAll).not.toHaveBeenCalled();
    });
  });

  describe('installManualEnvironmentSkills', () => {
    it('should write each manual skill into a temporary package and install it via the skills CLI', async () => {
      await manager.installManualEnvironmentSkills([
        {
          name: 'my-manual-skill',
          description: 'Manual test skill.',
          content: '# My Manual Skill\n',
        },
        {
          name: 'other-skill',
          description: 'Another manual test skill.',
          content: '# Other Skill\n',
        },
      ]);

      expect(mkdtemp).toHaveBeenCalledWith(
        join(workspaceRoot, '.roomote-manual-skills-'),
      );
      expect(mkdir).toHaveBeenCalledWith(
        '/workspace/.roomote-manual-skills-test/my-manual-skill',
        { recursive: true },
      );
      expect(writeFile).toHaveBeenCalledWith(
        '/workspace/.roomote-manual-skills-test/my-manual-skill/SKILL.md',
        `---
name: my-manual-skill
description: Manual test skill.
---

# My Manual Skill
`,
        'utf-8',
      );
      expect(mockExecute).toHaveBeenCalledWith({
        name: 'Install manual skills',
        run: "npx -y skills add '/workspace/.roomote-manual-skills-test' -g --all --copy",
        timeout: 600,
        continue_on_error: true,
      });
      expect(rm).toHaveBeenCalledWith(
        '/workspace/.roomote-manual-skills-test',
        { recursive: true, force: true },
      );
    });

    it('should no-op when no manual skills are provided', async () => {
      await manager.installManualEnvironmentSkills([]);

      expect(mkdtemp).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
