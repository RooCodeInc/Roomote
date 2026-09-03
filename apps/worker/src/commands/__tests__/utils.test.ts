import * as fs from 'fs';

import {
  buildEnvironmentShellEnvVars,
  injectEnvVars,
  writeBashrc,
  writeCommonEnvFile,
  isValidEnvVarName,
} from '../utils/env-vars';
import { TASK_MODEL_ROLE_DESCRIPTORS } from '@roomote/types';
import type { TaskRun } from '@roomote/sdk/client';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('http', () => ({
  createServer: vi.fn(() => ({
    on: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    address: vi.fn(() => ({ port: 7777 })),
  })),
}));

function findWrite(path: string) {
  return [...vi.mocked(fs.writeFileSync).mock.calls]
    .reverse()
    .find((call) => call[0] === path);
}

const COMMON_ENV_PATH = '/home/testuser/.roomote/env.sh';
const BASHRC_PATH = '/home/testuser/.bashrc';
const GH_TOKEN_ENV_PATH = '/home/testuser/.roomote/gh-token-env.sh';
const GITLAB_TOKEN_ENV_PATH = '/home/testuser/.roomote/gitlab-token-env.sh';
const GITEA_TOKEN_ENV_PATH = '/home/testuser/.roomote/gitea-token-env.sh';
const ADO_TOKEN_ENV_PATH = '/home/testuser/.roomote/ado-token-env.sh';
const GH_TOKEN_PATH = '/home/testuser/.roomote/gh-token';
const LEGACY_GITLAB_TOKEN_PATH = '/home/testuser/.roomote/gitlab-token';
const LEGACY_GITLAB_CREDENTIALS_PATH =
  '/home/testuser/.roomote/gitlab-repository-credentials.tsv';
const SOURCE_CONTROL_CREDENTIALS_PATH =
  '/home/testuser/.roomote/source-control-repository-credentials.tsv';
const SOURCE_CONTROL_GIT_CONFIG_PATH =
  '/home/testuser/.roomote/source-control-gitconfig';
const GH_WRAPPER_PATH = '/home/testuser/.roomote/bin/gh';
const GH_WRAPPER_BIN_PATH = '/home/testuser/.roomote/bin';
const DEFAULT_PATH = '/usr/local/bin:/usr/bin';
const originalPath = process.env.PATH;
const originalAuthBypassValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;
const originalAuthBypassHeaderName =
  process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
const originalPreviewProxyBaseUrl = process.env.PREVIEW_PROXY_BASE_URL;
const originalPreviewProxySubdomainSuffix =
  process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
  process.env.PATH = DEFAULT_PATH;
  delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
  delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
  delete process.env.PREVIEW_PROXY_BASE_URL;
  delete process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalAuthBypassValue === undefined) {
    delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
  } else {
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = originalAuthBypassValue;
  }

  if (originalAuthBypassHeaderName === undefined) {
    delete process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
  } else {
    process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = originalAuthBypassHeaderName;
  }

  if (originalPreviewProxyBaseUrl === undefined) {
    delete process.env.PREVIEW_PROXY_BASE_URL;
  } else {
    process.env.PREVIEW_PROXY_BASE_URL = originalPreviewProxyBaseUrl;
  }

  if (originalPreviewProxySubdomainSuffix === undefined) {
    delete process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
  } else {
    process.env.PREVIEW_PROXY_SUBDOMAIN_SUFFIX =
      originalPreviewProxySubdomainSuffix;
  }

  vi.restoreAllMocks();
});

describe('injectEnvVars', () => {
  it('omits inherited model transport values from the environment shell file without mutating runtime env', async () => {
    const inheritedRoleEnvVars = Object.fromEntries(
      Object.values(TASK_MODEL_ROLE_DESCRIPTORS).flatMap((descriptor) => [
        [descriptor.modelEnvVar, 'openai/outer-model'],
        [descriptor.reasoningEnvVar, 'high'],
        [`ROOMOTE_${descriptor.modelEnvVar.slice(2)}`, 'openai/outer-model'],
        [`ROOMOTE_${descriptor.reasoningEnvVar.slice(2)}`, 'high'],
      ]),
    );
    const envVars: Record<string, string> = {
      FOO: 'bar',
      ...inheritedRoleEnvVars,
      R_MODEL_ENV_KEYS: 'OPENAI_API_KEY',
      ROOMOTE_MODEL_ENV_KEYS: 'OPENAI_API_KEY',
    };

    await injectEnvVars(envVars, undefined, {
      omitInheritedModelRuntimeEnvFromShell: true,
    });

    expect(envVars.R_MODEL).toBe('openai/outer-model');
    const commonEnvContent = String(findWrite(COMMON_ENV_PATH)?.[1]);
    expect(commonEnvContent).toContain("export FOO='bar'");
    for (const name of Object.keys(inheritedRoleEnvVars)) {
      expect(commonEnvContent).not.toContain(`export ${name}=`);
    }
    expect(commonEnvContent).not.toContain('export R_MODEL_ENV_KEYS=');
    expect(commonEnvContent).not.toContain('export ROOMOTE_MODEL_ENV_KEYS=');
  });

  it('preserves explicitly configured nested model values in filtered shell env', () => {
    expect(
      buildEnvironmentShellEnvVars(
        {
          FOO: 'bar',
          R_MODEL: 'openai/nested-model',
          R_SMALL_MODEL: 'openai/outer-small-model',
        },
        ['R_MODEL'],
      ),
    ).toEqual({ FOO: 'bar', R_MODEL: 'openai/nested-model' });
  });

  it('prefers runtime auth bypass env vars over task run values', async () => {
    const envVars: Record<string, string> = {};
    const taskRun = {
      authBypassValue: 'task-run-bypass-value',
      authBypassHeaderName: 'x-task-run-bypass',
    } as TaskRun;

    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'runtime-bypass-value';
    process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = 'x-runtime-bypass';

    await injectEnvVars(envVars, taskRun);

    expect(envVars.ROOMOTE_AUTH_BYPASS_VALUE).toBe('runtime-bypass-value');
    expect(envVars.ROOMOTE_AUTH_BYPASS_HEADER_NAME).toBe('x-runtime-bypass');
  });

  it('injects auth bypass variables from the task run', async () => {
    const envVars: Record<string, string> = {};
    const taskRun = {
      authBypassValue: 'bypass-value',
      authBypassHeaderName: 'x-bypass-roomote-auth',
    } as TaskRun;

    await injectEnvVars(envVars, taskRun);

    expect(envVars.ROOMOTE_AUTH_BYPASS_VALUE).toBe('bypass-value');
    expect(envVars.ROOMOTE_AUTH_BYPASS_HEADER_NAME).toBe(
      'x-bypass-roomote-auth',
    );
    expect(envVars.ROOMOTE_WEB_HOST).toBeUndefined();
  });

  it('uses runtime auth bypass env vars when no task run is provided', async () => {
    const envVars: Record<string, string> = { FOO: 'bar' };

    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'runtime-bypass';
    process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME = 'x-runtime-bypass';

    await injectEnvVars(envVars);

    expect(envVars).toMatchObject({
      FOO: 'bar',
      ROOMOTE_AUTH_BYPASS_VALUE: 'runtime-bypass',
      ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-runtime-bypass',
      BASH_ENV: COMMON_ENV_PATH,
    });
  });

  it('builds preview-proxy hosts from an explicitly provided base URL even after process env scrub', async () => {
    const envVars: Record<string, string> = {};
    const taskRun = {
      taskId: 'task-123',
      machineDomains: {
        WEB: 'https://sandbox-web.modal.host',
      },
      proxyPorts: {
        WEB: 4321,
      },
    } as unknown as TaskRun;

    await injectEnvVars(envVars, taskRun, {
      previewProxyBaseUrl: 'https://preview.octomote.run',
    });

    expect(envVars.ROOMOTE_WEB_HOST).toBe(
      'https://task-123-web.preview.octomote.run',
    );
    expect(envVars.ROOMOTE_WEB_PREVIEW_URL).toBe(
      'https://task-123-web.preview.octomote.run',
    );
  });

  it('keeps direct hosts while exposing preview-proxy URLs for unproxied ports', async () => {
    const envVars: Record<string, string> = {};
    const taskRun = {
      taskId: 'task-123',
      machineDomains: {
        WEB: 'https://sandbox-web.modal.host',
      },
      proxyPorts: {},
    } as unknown as TaskRun;

    await injectEnvVars(envVars, taskRun, {
      previewProxyBaseUrl: 'https://preview.octomote.run',
    });

    expect(envVars.ROOMOTE_WEB_HOST).toBe('https://sandbox-web.modal.host');
    expect(envVars.ROOMOTE_WEB_PREVIEW_URL).toBe(
      'https://task-123-web.preview.octomote.run',
    );
  });

  it('does not expose a preview URL for the retired editor identity', async () => {
    const envVars: Record<string, string> = {
      ROOMOTE_EDITOR_PREVIEW_URL: 'https://stale-editor.example.com',
    };
    const taskRun = {
      taskId: 'task-123',
      machineDomains: {
        EDITOR: 'https://sandbox-editor.modal.host',
      },
      proxyPorts: {},
    } as unknown as TaskRun;

    await injectEnvVars(envVars, taskRun, {
      previewProxyBaseUrl: 'https://preview.octomote.run',
    });

    expect(envVars.ROOMOTE_EDITOR_PREVIEW_URL).toBeUndefined();
  });

  describe('PREVIEW_DOMAINS derivation', () => {
    it('derives PREVIEW_DOMAINS from the preview-proxy base URL hostname', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        previewProxyBaseUrl: 'https://preview.octomote.run',
      });

      expect(envVars.PREVIEW_DOMAINS).toBe('preview.octomote.run');
    });

    it('strips the port from the derived preview domain', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        previewProxyBaseUrl: 'http://roomotepreview.localhost:18081',
      });

      expect(envVars.PREVIEW_DOMAINS).toBe('roomotepreview.localhost');
    });

    it('keeps a deployment-provided PREVIEW_DOMAINS value', async () => {
      const envVars: Record<string, string> = {
        PREVIEW_DOMAINS: 'custom.example.com',
      };

      await injectEnvVars(envVars, undefined, {
        previewProxyBaseUrl: 'https://preview.octomote.run',
      });

      expect(envVars.PREVIEW_DOMAINS).toBe('custom.example.com');
    });

    it('falls back to the process env preview-proxy base URL', async () => {
      const envVars: Record<string, string> = {};

      process.env.PREVIEW_PROXY_BASE_URL = 'https://preview.roomote.dev';

      await injectEnvVars(envVars);

      expect(envVars.PREVIEW_DOMAINS).toBe('preview.roomote.dev');
    });

    it('does not set PREVIEW_DOMAINS without a preview-proxy base URL', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars);

      expect(envVars.PREVIEW_DOMAINS).toBeUndefined();
    });

    it('ignores an invalid preview-proxy base URL', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        previewProxyBaseUrl: 'not-a-url',
      });

      expect(envVars.PREVIEW_DOMAINS).toBeUndefined();
    });
  });

  describe('bashrc writing', () => {
    it('writes env vars to the common env file and sources it from .bashrc', async () => {
      const envVars: Record<string, string> = {
        MY_VAR: 'my_value',
      };

      await injectEnvVars(envVars);

      expect(fs.writeFileSync).toHaveBeenCalled();

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toContain("export MY_VAR='my_value'");
      expect(envContent).toContain(`source '${GH_TOKEN_ENV_PATH}'`);
      expect(envContent).toContain(`source '${GITLAB_TOKEN_ENV_PATH}'`);
      expect(envContent).toContain(`source '${GITEA_TOKEN_ENV_PATH}'`);
      expect(envContent).toContain(`source '${ADO_TOKEN_ENV_PATH}'`);

      const bashrcWrite = findWrite(BASHRC_PATH);
      const bashrcContent = bashrcWrite?.[1] as string | undefined;
      expect(bashrcContent).toContain(`source '${COMMON_ENV_PATH}'`);
      expect(bashrcContent).not.toContain('export MY_VAR=');
      expect(envVars.BASH_ENV).toBe(COMMON_ENV_PATH);
    });

    it('escapes single quotes in values', async () => {
      const envVars: Record<string, string> = {
        MY_VAR: "value with 'quotes'",
      };

      await injectEnvVars(envVars);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toMatch(/export MY_VAR='value with '\\''quotes'\\'''/);
    });

    it('removes previous env var section before writing new one', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'existing content\n# BEGIN Roomote environment variables\nexport OLD_VAR=old\n# END Roomote environment variables\nmore content',
      );

      const envVars: Record<string, string> = { NEW_VAR: 'new' };
      await injectEnvVars(envVars);

      const bashrcWrite = findWrite(BASHRC_PATH);
      const writtenContent = bashrcWrite?.[1] as string | undefined;
      expect(writtenContent).toContain('existing content');
      expect(writtenContent).toContain('more content');
      expect(writtenContent).not.toContain('OLD_VAR');
      expect(writtenContent).toContain(`source '${COMMON_ENV_PATH}'`);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toContain("export NEW_VAR='new'");
    });

    it('does not write GH_TOKEN directly to env file', async () => {
      const envVars: Record<string, string> = {
        GH_TOKEN: 'ghs_test_token',
      };

      await injectEnvVars(envVars);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toBeDefined();
      expect(envContent).not.toContain('ghs_test_token');
      expect(envContent).not.toContain('export GH_TOKEN=');
    });

    it('does not write GITLAB_TOKEN directly to env file', async () => {
      const envVars: Record<string, string> = {
        GITLAB_TOKEN: 'glpat_test_token',
      };

      await injectEnvVars(envVars);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toBeDefined();
      expect(envContent).not.toContain('glpat_test_token');
      expect(envContent).not.toContain('export GITLAB_TOKEN=');
    });

    it('does not write GITEA_TOKEN directly to env file', async () => {
      const envVars: Record<string, string> = {
        GITEA_TOKEN: 'gitea_test_token',
      };

      await injectEnvVars(envVars);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toBeDefined();
      expect(envContent).not.toContain('gitea_test_token');
      expect(envContent).not.toContain('export GITEA_TOKEN=');
    });

    it('does not write ADO_TOKEN directly to env file', async () => {
      const envVars: Record<string, string> = {
        ADO_TOKEN: 'ado_test_token',
      };

      await injectEnvVars(envVars);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toBeDefined();
      expect(envContent).not.toContain('ado_test_token');
      expect(envContent).not.toContain('export ADO_TOKEN=');
    });

    it('clears stale GitLab token files for GitHub jobs', async () => {
      const envVars: Record<string, string> = {
        GH_TOKEN: 'ghs_test_token',
      };

      await injectEnvVars(envVars);

      expect(findWrite(GH_TOKEN_PATH)?.[1]).toBe('ghs_test_token\n');
      expect(fs.rmSync).toHaveBeenCalledWith(SOURCE_CONTROL_CREDENTIALS_PATH, {
        force: true,
      });
      expect(fs.rmSync).toHaveBeenCalledWith(LEGACY_GITLAB_CREDENTIALS_PATH, {
        force: true,
      });
      expect(fs.rmSync).toHaveBeenCalledWith(LEGACY_GITLAB_TOKEN_PATH, {
        force: true,
      });
      expect(fs.rmSync).not.toHaveBeenCalledWith(GH_TOKEN_PATH, {
        force: true,
      });
    });

    it('writes repo-scoped source-control credentials instead of exporting a deployment token', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        sourceControlToken: {
          provider: 'gitlab',
          token: 'glptt_scoped_token',
          envVar: 'GITLAB_TOKEN',
          envVars: {},
          gitCredentials: [
            {
              host: 'gitlab.com',
              repositoryFullName: 'group/project',
              username: 'oauth2',
              token: 'glptt_scoped_token',
            },
          ],
        },
      });

      expect(findWrite(SOURCE_CONTROL_CREDENTIALS_PATH)?.[1]).toBe(
        'gitlab.com\tgroup/project\toauth2\tglptt_scoped_token\n',
      );
      expect(fs.rmSync).toHaveBeenCalledWith(GH_TOKEN_PATH, { force: true });
      expect(fs.rmSync).toHaveBeenCalledWith(LEGACY_GITLAB_TOKEN_PATH, {
        force: true,
      });

      const gitLabEnvWrite = findWrite(GITLAB_TOKEN_ENV_PATH);
      const gitLabEnvContent = gitLabEnvWrite?.[1] as string | undefined;
      expect(gitLabEnvContent).toContain('unset GITLAB_TOKEN');
    });

    it('routes Gitea git access through the local proxy without writing the PAT to disk', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        sourceControlToken: {
          provider: 'gitea',
          token: '',
          envVar: 'GITEA_TOKEN',
          envVars: {},
          gitProxyCredentials: [
            {
              provider: 'gitea',
              host: 'git.example.com',
              repositoryFullName: 'group/project',
              username: 'roomote-bot',
              token: 'gitea_deployment_token',
              originBaseUrl: 'https://git.example.com',
            },
          ],
        },
      });

      expect(findWrite(SOURCE_CONTROL_CREDENTIALS_PATH)).toBeUndefined();
      expect(findWrite(SOURCE_CONTROL_GIT_CONFIG_PATH)?.[1]).toContain(
        'insteadOf = https://git.example.com/',
      );
      expect(findWrite(SOURCE_CONTROL_GIT_CONFIG_PATH)?.[1]).not.toContain(
        'gitea_deployment_token',
      );

      const giteaEnvWrite = findWrite(GITEA_TOKEN_ENV_PATH);
      const giteaEnvContent = giteaEnvWrite?.[1] as string | undefined;
      expect(giteaEnvContent).toContain('unset GITEA_TOKEN');
    });

    it('routes Azure DevOps git access through the local proxy without writing the PAT to disk', async () => {
      const envVars: Record<string, string> = {};

      await injectEnvVars(envVars, undefined, {
        sourceControlToken: {
          provider: 'ado',
          token: '',
          envVar: 'ADO_TOKEN',
          envVars: {},
          gitProxyCredentials: [
            {
              provider: 'ado',
              host: 'dev.azure.com',
              repositoryFullName: 'acme/Platform/_git/backend',
              username: 'ado',
              token: 'ado_deployment_token',
              originBaseUrl: 'https://dev.azure.com',
            },
          ],
        },
      });

      expect(findWrite(SOURCE_CONTROL_CREDENTIALS_PATH)).toBeUndefined();
      expect(findWrite(SOURCE_CONTROL_GIT_CONFIG_PATH)?.[1]).toContain(
        'insteadOf = https://dev.azure.com/',
      );
      expect(findWrite(SOURCE_CONTROL_GIT_CONFIG_PATH)?.[1]).not.toContain(
        'ado_deployment_token',
      );

      const adoEnvWrite = findWrite(ADO_TOKEN_ENV_PATH);
      const adoEnvContent = adoEnvWrite?.[1] as string | undefined;
      expect(adoEnvContent).toContain('unset ADO_TOKEN');
    });

    it('can reload deployment env vars without touching source control credential files', async () => {
      const envVars: Record<string, string> = {
        OPENAI_API_KEY: 'sk-test',
      };
      vi.mocked(fs.existsSync).mockImplementation(
        (targetPath) => targetPath === SOURCE_CONTROL_GIT_CONFIG_PATH,
      );

      await injectEnvVars(envVars, undefined, {
        syncSourceControlTokenFiles: false,
      });

      expect(findWrite(GH_TOKEN_PATH)).toBeUndefined();
      expect(findWrite(SOURCE_CONTROL_CREDENTIALS_PATH)).toBeUndefined();
      expect(findWrite(SOURCE_CONTROL_GIT_CONFIG_PATH)).toBeUndefined();
      expect(fs.rmSync).not.toHaveBeenCalledWith(GH_TOKEN_PATH, {
        force: true,
      });
      expect(fs.rmSync).not.toHaveBeenCalledWith(
        SOURCE_CONTROL_CREDENTIALS_PATH,
        {
          force: true,
        },
      );
      expect(fs.rmSync).not.toHaveBeenCalledWith(LEGACY_GITLAB_TOKEN_PATH, {
        force: true,
      });
    });

    it('preserves explicit Sentry env vars in the worker shell env', async () => {
      const envVars: Record<string, string> = {
        SENTRY_AUTH_TOKEN: 'sntrys_secret',
        SENTRY_ORG: 'roomote',
      };

      await injectEnvVars(envVars);

      expect(envVars.SENTRY_AUTH_TOKEN).toBe('sntrys_secret');
      expect(envVars.SENTRY_ORG).toBe('roomote');

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toBeDefined();
      expect(envContent).toContain("export SENTRY_AUTH_TOKEN='sntrys_secret'");
      expect(envContent).toContain("export SENTRY_ORG='roomote'");
    });

    it('prepends a file-backed gh wrapper to PATH for long-running processes', async () => {
      const envVars: Record<string, string> = {
        GH_TOKEN: 'ghs_test_token',
        PATH: DEFAULT_PATH,
      };

      await injectEnvVars(envVars);

      expect(envVars.PATH).toBe(DEFAULT_PATH);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toContain(
        `export PATH='${GH_WRAPPER_BIN_PATH}':"$PATH"`,
      );

      const wrapperWrite = findWrite(GH_WRAPPER_PATH);
      const wrapperContent = wrapperWrite?.[1] as string | undefined;
      expect(wrapperContent).toContain(
        'GH_TOKEN_FILE="$HOME/.roomote/gh-token"',
      );
      expect(wrapperContent).toContain('exec "$candidate" "$@"');
    });

    it('does not duplicate the gh wrapper path on repeated env injection', async () => {
      const envVars: Record<string, string> = {
        PATH: `${GH_WRAPPER_BIN_PATH}:${DEFAULT_PATH}`,
      };

      await injectEnvVars(envVars);

      expect(envVars.PATH).toBe(`${GH_WRAPPER_BIN_PATH}:${DEFAULT_PATH}`);

      const envWrite = findWrite(COMMON_ENV_PATH);
      const envContent = envWrite?.[1] as string | undefined;
      expect(envContent).toContain(
        `export PATH='${GH_WRAPPER_BIN_PATH}':"$PATH"`,
      );
    });
  });
});

describe('isValidEnvVarName', () => {
  it('accepts valid POSIX variable names', async () => {
    expect(isValidEnvVarName('FOO')).toBe(true);
    expect(isValidEnvVarName('_BAR')).toBe(true);
    expect(isValidEnvVarName('FOO_123')).toBe(true);
  });

  it('rejects invalid variable names', async () => {
    expect(isValidEnvVarName('1FOO')).toBe(false);
    expect(isValidEnvVarName('FOO-BAR')).toBe(false);
    expect(isValidEnvVarName('FOO BAR')).toBe(false);
    expect(isValidEnvVarName('FOO;rm -rf /')).toBe(false);
  });
});

describe('writeCommonEnvFile', () => {
  it('writes a guard, exports, and GH token source', async () => {
    writeCommonEnvFile({ FOO: 'bar' });

    const envWrite = findWrite(COMMON_ENV_PATH);
    const content = envWrite?.[1] as string | undefined;
    expect(content).toContain('export __ROOMOTE_ENV_LOADED=1');
    expect(content).toContain("export FOO='bar'");
    expect(content).toContain(`source '${GH_TOKEN_ENV_PATH}'`);
    expect(content).toContain(`source '${GITLAB_TOKEN_ENV_PATH}'`);
    expect(content).toContain(`source '${GITEA_TOKEN_ENV_PATH}'`);
    expect(content).toContain(`source '${ADO_TOKEN_ENV_PATH}'`);
    expect(envWrite?.[2]).toEqual({ mode: 0o600 });
    expect(fs.chmodSync).toHaveBeenCalledWith(COMMON_ENV_PATH, 0o600);
  });
});

describe('writeBashrc', () => {
  it('appends a marked section that sources the common env file', async () => {
    writeBashrc({ FOO: 'bar' });

    const bashrcWrite = findWrite(BASHRC_PATH);
    const content = bashrcWrite?.[1] as string | undefined;
    expect(content).toContain('# BEGIN Roomote environment variables');
    expect(content).toContain(`source '${COMMON_ENV_PATH}'`);
    expect(content).toContain('# END Roomote environment variables');
  });
});
