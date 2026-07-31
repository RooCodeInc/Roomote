import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';

import {
  configureAuthClientEnv,
  validateAuthToken,
  validateRunToken,
} from '@roomote/auth/client';

import { WorkerEnv } from '../worker-env';

describe('WorkerEnv', () => {
  let workerEnv: WorkerEnv;

  beforeEach(() => {
    workerEnv = new WorkerEnv({
      systemBase: {
        HOME: '/home/testuser',
        PATH: '/usr/bin:/usr/local/bin',
        LC_ALL: 'C.UTF-8',
        NODE_ENV: 'test',
        PNPM_HOME: '/home/testuser/.local/share/pnpm',
      },
      workerConfig: {
        authToken: 'secret-auth-token',
        trpcUrl: 'https://trpc.internal.example.com',
        jobAuthPublicKey: 'job-public-key-data',
        previewProxyBaseUrl: 'https://preview.roomote.run',
        previewAuthPublicKey: 'public-key-data',
        roomoteAppUrl: 'https://app.roomote.example',
        appEnv: 'development',
      },
    });
  });

  afterEach(() => {
    configureAuthClientEnv(null);
  });

  describe('buildSetupEnv', () => {
    it('should include system base vars', () => {
      const env = workerEnv.buildSetupEnv();

      expect(env.HOME).toBe('/home/testuser');
      expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
      expect(env.SKIP_ENV_VALIDATION).toBe('1');
    });

    it('should NOT include worker infrastructure secrets', () => {
      const env = workerEnv.buildSetupEnv();

      expect(env).not.toHaveProperty('AUTH_TOKEN');
      expect(env).not.toHaveProperty('TRPC_URL');
      expect(env).not.toHaveProperty('PREVIEW_PROXY_BASE_URL');
      expect(env).not.toHaveProperty('PREVIEW_AUTH_PUBLIC_KEY');
      expect(env).not.toHaveProperty('R_APP_URL');
    });
  });

  describe('buildServiceInstallEnv', () => {
    it('should include only system base vars', () => {
      const env = workerEnv.buildServiceInstallEnv();

      expect(env.HOME).toBe('/home/testuser');
      expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
      expect(env.NODE_ENV).toBe('test');
    });

    it('should NOT include worker secrets', () => {
      const env = workerEnv.buildServiceInstallEnv();

      expect(env).not.toHaveProperty('AUTH_TOKEN');
      expect(env).not.toHaveProperty('TRPC_URL');
    });
  });

  describe('buildUserFacingEnv', () => {
    it('should include system base, service env, and user env', () => {
      workerEnv.addServiceEnv({
        POSTGRES_URL: 'postgres://localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
      });

      workerEnv.addUserEnv({
        MY_APP_KEY: 'user-value',
        BASH_ENV: '/tmp/gh-token.env',
      });

      const env = workerEnv.buildUserFacingEnv();

      // System base
      expect(env.HOME).toBe('/home/testuser');
      expect(env.PATH).toBe('/usr/bin:/usr/local/bin');

      // The deployment's app env is worker-internal and must never leak into
      // user-facing processes (it would clobber sandbox dev-server overrides).
      expect(env).not.toHaveProperty('APP_ENV');
      expect(env).not.toHaveProperty('R_APP_ENV');
      expect(env).not.toHaveProperty('ROOMOTE_APP_ENV');

      // Service env
      expect(env.POSTGRES_URL).toBe('postgres://localhost:5432/db');
      expect(env.REDIS_URL).toBe('redis://localhost:6379');

      // User env
      expect(env.MY_APP_KEY).toBe('user-value');
      expect(env.BASH_ENV).toBe('/tmp/gh-token.env');
    });

    it('should NOT include worker secrets', () => {
      const env = workerEnv.buildUserFacingEnv();

      expect(env).not.toHaveProperty('AUTH_TOKEN');
      expect(env).not.toHaveProperty('TRPC_URL');
      expect(env).not.toHaveProperty('PREVIEW_AUTH_PUBLIC_KEY');
      expect(env).not.toHaveProperty('PREVIEW_PROXY_BASE_URL');
      expect(env).not.toHaveProperty('R_APP_URL');
    });

    it('should keep launcher model env available only for harnesses', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'secret-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        R_MODEL: 'openrouter/openai/gpt-5.4',
        R_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
        R_VISION_MODEL: 'openrouter/openai/gpt-5.5',
        R_CODE_REVIEW_MODEL: 'openrouter/openai/gpt-5.5',
        R_EXPLORE_MODEL: 'openrouter/openai/gpt-5.4-mini',
        R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
        R_MODEL_REASONING_EFFORT: 'medium',
        R_SMALL_MODEL_REASONING_EFFORT: 'low',
        R_VISION_MODEL_REASONING_EFFORT: 'low',
        R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
        R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
        R_PLANNING_MODEL_REASONING_EFFORT: 'high',
        R_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
        OPENROUTER_API_KEY: 'openrouter-key',
        CUSTOM_PROVIDER_API_KEY: 'custom-key',
        JOB_AUTH_PRIVATE_KEY: 'do-not-forward',
      } as NodeJS.ProcessEnv);

      env.setRuntimeEnv({ GH_TOKEN: 'gh-token' });

      const userEnv = env.buildUserFacingEnv();
      expect(userEnv).not.toHaveProperty('R_MODEL');
      expect(userEnv).not.toHaveProperty('R_SMALL_MODEL');
      expect(userEnv).not.toHaveProperty('R_VISION_MODEL');
      expect(userEnv).not.toHaveProperty('R_CODE_REVIEW_MODEL');
      expect(userEnv).not.toHaveProperty('R_EXPLORE_MODEL');
      expect(userEnv).not.toHaveProperty('R_PLANNING_MODEL');
      expect(userEnv).not.toHaveProperty('R_MODEL_REASONING_EFFORT');
      expect(userEnv).not.toHaveProperty('R_PLANNING_MODEL_REASONING_EFFORT');
      expect(userEnv).not.toHaveProperty('OPENROUTER_API_KEY');

      const openCodeEnv = env.buildOpenCodeHarnessEnv();
      expect(openCodeEnv.R_MODEL).toBe('openrouter/openai/gpt-5.4');
      expect(openCodeEnv.R_SMALL_MODEL).toBe('openrouter/openai/gpt-5.4-mini');
      expect(openCodeEnv.R_VISION_MODEL).toBe('openrouter/openai/gpt-5.5');
      expect(openCodeEnv.R_CODE_REVIEW_MODEL).toBe('openrouter/openai/gpt-5.5');
      expect(openCodeEnv.R_EXPLORE_MODEL).toBe(
        'openrouter/openai/gpt-5.4-mini',
      );
      expect(openCodeEnv.R_PLANNING_MODEL).toBe(
        'openrouter/anthropic/claude-opus-4.7',
      );
      expect(openCodeEnv.R_MODEL_REASONING_EFFORT).toBe('medium');
      expect(openCodeEnv.R_SMALL_MODEL_REASONING_EFFORT).toBe('low');
      expect(openCodeEnv.R_VISION_MODEL_REASONING_EFFORT).toBe('low');
      expect(openCodeEnv.R_CODE_REVIEW_MODEL_REASONING_EFFORT).toBe('high');
      expect(openCodeEnv.R_EXPLORE_MODEL_REASONING_EFFORT).toBe('low');
      expect(openCodeEnv.R_PLANNING_MODEL_REASONING_EFFORT).toBe('high');
      expect(openCodeEnv.R_MODEL_ENV_KEYS).toBe('CUSTOM_PROVIDER_API_KEY');
      expect(openCodeEnv.OPENROUTER_API_KEY).toBe('openrouter-key');
      expect(openCodeEnv.CUSTOM_PROVIDER_API_KEY).toBe('custom-key');
      expect(openCodeEnv).not.toHaveProperty('JOB_AUTH_PRIVATE_KEY');
    });
  });

  describe('addServiceEnv', () => {
    it('should merge service env vars', () => {
      workerEnv.addServiceEnv({ POSTGRES_URL: 'pg://localhost' });
      workerEnv.addServiceEnv({ REDIS_URL: 'redis://localhost' });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.POSTGRES_URL).toBe('pg://localhost');
      expect(env.REDIS_URL).toBe('redis://localhost');
    });
  });

  describe('addUserEnv', () => {
    it('should merge user env vars', () => {
      workerEnv.addUserEnv({ FOO: 'bar' });
      workerEnv.addUserEnv({ BAZ: 'qux' });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });

    it('should skip undefined values', () => {
      workerEnv.addUserEnv({ DEFINED: 'yes', UNDEFINED: undefined });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.DEFINED).toBe('yes');
      expect(env).not.toHaveProperty('UNDEFINED');
    });

    it('should allow user env to override service env', () => {
      workerEnv.addServiceEnv({ DATABASE_URL: 'service-url' });
      workerEnv.addUserEnv({ DATABASE_URL: 'user-override-url' });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.DATABASE_URL).toBe('user-override-url');
    });

    it('should let setup-added user env override runtime env', () => {
      workerEnv.setRuntimeEnv({ OPENAI_API_KEY: 'runtime-value' });
      workerEnv.addUserEnv({ OPENAI_API_KEY: 'workspace-override' });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.OPENAI_API_KEY).toBe('workspace-override');
    });
  });

  describe('runtime env', () => {
    it('should merge runtime env vars', () => {
      workerEnv.setRuntimeEnv({ OPENAI_API_KEY: 'key-1' });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.OPENAI_API_KEY).toBe('key-1');
    });

    it('should replace runtime env vars when setRuntimeEnv is called again', () => {
      workerEnv.setRuntimeEnv({
        LEGACY_KEY: 'legacy',
        GH_TOKEN: 'gh-token',
      });

      workerEnv.setRuntimeEnv({
        OPENAI_API_KEY: 'new-key',
        GH_TOKEN: 'gh-token',
      });

      const env = workerEnv.buildUserFacingEnv();
      expect(env.OPENAI_API_KEY).toBe('new-key');
      expect(env.GH_TOKEN).toBe('gh-token');
      expect(env.LEGACY_KEY).toBeUndefined();
    });
  });

  describe('accessors', () => {
    it('should provide access to worker config values', () => {
      expect(workerEnv.jobAuthPublicKey).toBe('job-public-key-data');
      expect(workerEnv.previewProxyBaseUrl).toBe('https://preview.roomote.run');
      expect(workerEnv.previewAuthPublicKey).toBe('public-key-data');
      expect(workerEnv.roomoteAppUrl).toBe('https://app.roomote.example');
      expect(workerEnv.authToken).toBe('secret-auth-token');
      expect(workerEnv.appEnv).toBe('development');
    });
  });

  describe('fromProcessEnv', () => {
    it('should capture worker secrets from process env', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin',
        LC_ALL: 'C.UTF-8',
        AUTH_TOKEN: 'my-auth-token',
        TRPC_URL: 'https://trpc.example.com',
        JOB_AUTH_PRIVATE_KEY: 'job-private-key-data',
        JOB_AUTH_PUBLIC_KEY: 'job-pk-data',
        PREVIEW_PROXY_BASE_URL: 'https://preview.example.com',
        PREVIEW_AUTH_PUBLIC_KEY: 'pk-data',
        R_APP_URL: 'https://api.example.com',
        R_APP_ENV: 'production',
      } as NodeJS.ProcessEnv);

      // Worker secrets are accessible via accessors
      expect(env.authToken).toBe('my-auth-token');
      expect(env.jobAuthPublicKey).toBe('job-pk-data');
      expect(env.previewProxyBaseUrl).toBe('https://preview.example.com');
      expect(env.roomoteAppUrl).toBe('https://api.example.com');

      // But NOT present in any child process env
      const userEnv = env.buildUserFacingEnv();
      expect(userEnv).not.toHaveProperty('AUTH_TOKEN');
      expect(userEnv).not.toHaveProperty('TRPC_URL');
      expect(userEnv).not.toHaveProperty('PREVIEW_AUTH_PUBLIC_KEY');
      expect(userEnv).not.toHaveProperty('R_APP_URL');

      // System base vars are present
      expect(userEnv.HOME).toBe('/home/worker');
      expect(userEnv.LC_ALL).toBe('C.UTF-8');
      // The deployment app env stays worker-internal only
      expect(userEnv).not.toHaveProperty('APP_ENV');
      expect(userEnv).not.toHaveProperty('R_APP_ENV');
      expect(userEnv).not.toHaveProperty('ROOMOTE_APP_ENV');
      expect(env.appEnv).toBe('production');
    });

    it('should preserve the task-scoped Docker daemon endpoint', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'my-auth-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        DOCKER_HOST: 'tcp://127.0.0.1:2375',
      } as NodeJS.ProcessEnv);

      expect(env.buildUserFacingEnv().DOCKER_HOST).toBe('tcp://127.0.0.1:2375');
    });

    it('captures clone timeout configuration without exposing it to task processes', () => {
      const processEnv = {
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'my-auth-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        WORKER_REPOSITORY_CLONE_TIMEOUT_SECONDS: '1200',
      } as NodeJS.ProcessEnv;

      const env = WorkerEnv.fromProcessEnv(processEnv);

      expect(env.repositoryCloneTimeoutSeconds).toBe(1_200);
      expect(
        processEnv.WORKER_REPOSITORY_CLONE_TIMEOUT_SECONDS,
      ).toBeUndefined();
      expect(env.buildUserFacingEnv()).not.toHaveProperty(
        'WORKER_REPOSITORY_CLONE_TIMEOUT_SECONDS',
      );
    });

    it('should keep sandbox auth validation working after process.env cleanup', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const fakeProcessEnv: Record<string, string | undefined> = {
        HOME: '/home/worker',
        PATH: '/usr/bin',
        NODE_ENV: 'test',
        SKIP_ENV_VALIDATION: '1',
        AUTH_TOKEN: 'secret-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        R_APP_ENV: 'preview',
        JOB_AUTH_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
        JOB_AUTH_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
        PREVIEW_AUTH_PUBLIC_KEY: 'outer-preview-key',
        PREVIEW_PROXY_BASE_URL: 'https://preview.example.com',
      };

      const env = WorkerEnv.fromProcessEnv(fakeProcessEnv as NodeJS.ProcessEnv);

      expect(fakeProcessEnv.JOB_AUTH_PRIVATE_KEY).toBeUndefined();
      expect(fakeProcessEnv.JOB_AUTH_PUBLIC_KEY).toBeUndefined();
      expect(fakeProcessEnv.PREVIEW_AUTH_PUBLIC_KEY).toBeUndefined();
      expect(fakeProcessEnv.PREVIEW_PROXY_BASE_URL).toBeUndefined();
      expect(fakeProcessEnv.R_APP_ENV).toBeUndefined();

      expect(env.jobAuthPublicKey).toBe(
        Buffer.from(publicKey).toString('base64'),
      );
      expect(env.previewAuthPublicKey).toBe('outer-preview-key');
      expect(env.previewProxyBaseUrl).toBe('https://preview.example.com');
      expect(env.appEnv).toBe('preview');

      const token = jwt.sign(
        {
          iss: 'rcc',
          sub: '123',
          exp: Math.floor(Date.now() / 1000) + 600,
          iat: Math.floor(Date.now() / 1000),
          nbf: Math.floor(Date.now() / 1000) - 30,
          v: 1,
          r: {
            u: 'user-123',
            o: 'org-456',
            t: 'run',
          },
        },
        privateKey,
        { algorithm: 'ES256' },
      );

      await expect(validateRunToken(token)).resolves.toEqual({
        runId: 123,
        userId: 'user-123',
        principal: 'user',
        tokenType: 'run',
        version: 1,
      });

      const authToken = jwt.sign(
        {
          iss: 'rcc',
          sub: 'user-123',
          exp: Math.floor(Date.now() / 1000) + 600,
          iat: Math.floor(Date.now() / 1000),
          nbf: Math.floor(Date.now() / 1000) - 30,
          v: 1,
          r: {
            u: 'user-123',
            o: 'org-456',
            t: 'auth',
          },
        },
        privateKey,
        { algorithm: 'ES256' },
      );

      await expect(validateAuthToken(authToken)).resolves.toEqual({
        userId: 'user-123',
        tokenType: 'auth',
        version: 1,
      });
    });

    it('should fall back to APP_ENV for older launcher env', () => {
      const processEnv = {
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'my-auth-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        APP_ENV: 'preview',
      } as NodeJS.ProcessEnv;

      const env = WorkerEnv.fromProcessEnv(processEnv);

      expect(env.appEnv).toBe('preview');
      expect(processEnv.APP_ENV).toBeUndefined();
      expect(env.buildUserFacingEnv()).not.toHaveProperty('APP_ENV');
      expect(env.buildUserFacingEnv()).not.toHaveProperty('R_APP_ENV');
    });

    it('should throw if required env vars are not set', () => {
      expect(() =>
        WorkerEnv.fromProcessEnv({
          HOME: '/home/worker',
          PATH: '/usr/bin',
        } as NodeJS.ProcessEnv),
      ).toThrow('AUTH_TOKEN is not set');

      expect(() =>
        WorkerEnv.fromProcessEnv({
          HOME: '/home/worker',
          PATH: '/usr/bin',
          AUTH_TOKEN: 'token',
        } as NodeJS.ProcessEnv),
      ).toThrow('TRPC_URL is not set');

      expect(() =>
        WorkerEnv.fromProcessEnv({
          HOME: '/home/worker',
          PATH: '/usr/bin',
          AUTH_TOKEN: 'token',
          TRPC_URL: 'https://trpc.example.com',
        } as NodeJS.ProcessEnv),
      ).toThrow('R_APP_URL is not set');
    });

    it('should include MISE_* vars in system base', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        MISE_DATA_DIR: '/home/worker/.local/share/mise',
        MISE_CACHE_DIR: '/home/worker/.cache/mise',
      } as NodeJS.ProcessEnv);

      const userEnv = env.buildUserFacingEnv();
      expect(userEnv.MISE_DATA_DIR).toBe('/home/worker/.local/share/mise');
      expect(userEnv.MISE_CACHE_DIR).toBe('/home/worker/.cache/mise');
    });

    it('should ensure mise shims are on PATH', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin:/usr/local/bin',
        AUTH_TOKEN: 'token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
      } as NodeJS.ProcessEnv);

      const userEnv = env.buildUserFacingEnv();
      expect(userEnv.PATH).toContain('/home/worker/.local/share/mise/shims');
      expect(userEnv.PATH).toContain('/home/worker/.local/bin');
    });
  });

  describe('process.env cleanup', () => {
    it('should delete worker secrets from the passed processEnv object', () => {
      const fakeProcessEnv: Record<string, string | undefined> = {
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'secret-token',
        TRPC_URL: 'https://trpc.example.com',
        R_APP_URL: 'https://api.example.com',
        R_APP_ENV: 'production',
        ROOMOTE_APP_ENV: 'production',
        JOB_AUTH_PRIVATE_KEY: 'outer-job-private-key',
        PREVIEW_AUTH_PUBLIC_KEY: 'outer-public-key',
        PREVIEW_AUTH_COOKIE_NAME: 'preview_auth',
        JOB_AUTH_PUBLIC_KEY: 'outer-job-key',
        PREVIEW_PROXY_BASE_URL: 'https://preview.example.com',
        PREVIEW_PROXY_SUBDOMAIN_SUFFIX: '.outer.example.com',
      };

      const env = WorkerEnv.fromProcessEnv(fakeProcessEnv as NodeJS.ProcessEnv);

      // Values are captured in WorkerEnv
      expect(env.authToken).toBe('secret-token');
      expect(env.previewAuthPublicKey).toBe('outer-public-key');
      expect(env.previewAuthCookieName).toBe('preview_auth');
      expect(env.previewProxyBaseUrl).toBe('https://preview.example.com');
      expect(env.previewProxySubdomainSuffix).toBe('.outer.example.com');
      expect(env.appEnv).toBe('production');

      // Preview/auth keys deleted from processEnv (won't leak to child processes)
      expect(fakeProcessEnv.PREVIEW_AUTH_PUBLIC_KEY).toBeUndefined();
      expect(fakeProcessEnv.PREVIEW_AUTH_COOKIE_NAME).toBeUndefined();
      expect(fakeProcessEnv.JOB_AUTH_PRIVATE_KEY).toBeUndefined();
      expect(fakeProcessEnv.JOB_AUTH_PUBLIC_KEY).toBeUndefined();
      expect(fakeProcessEnv.PREVIEW_PROXY_BASE_URL).toBeUndefined();
      expect(fakeProcessEnv.PREVIEW_PROXY_SUBDOMAIN_SUFFIX).toBeUndefined();
      expect(fakeProcessEnv.R_APP_ENV).toBeUndefined();
      expect(fakeProcessEnv.ROOMOTE_APP_ENV).toBeUndefined();

      // AUTH_TOKEN is intentionally kept — the SDK tRPC client reads it
      // from process.env on every request.
      expect(fakeProcessEnv.AUTH_TOKEN).toBe('secret-token');

      // Other keys are also kept
      expect(fakeProcessEnv.HOME).toBe('/home/worker');
      expect(fakeProcessEnv.PATH).toBeDefined();
      expect(fakeProcessEnv.TRPC_URL).toBe('https://trpc.example.com');
      expect(fakeProcessEnv.R_APP_URL).toBe('https://api.example.com');
    });
  });

  describe('environment isolation (dogfooding scenario)', () => {
    it('should prevent worker TRPC_URL from appearing in user-facing env', () => {
      const env = WorkerEnv.fromProcessEnv({
        HOME: '/home/worker',
        PATH: '/usr/bin',
        AUTH_TOKEN: 'token',
        TRPC_URL: 'https://internal-worker-trpc.example.com',
        R_APP_URL: 'https://internal-api.example.com',
      } as NodeJS.ProcessEnv);

      // User project can set its own TRPC_URL without conflict
      env.addUserEnv({ TRPC_URL: 'https://my-project-trpc.example.com' });

      const userEnv = env.buildUserFacingEnv();
      expect(userEnv.TRPC_URL).toBe('https://my-project-trpc.example.com');

      // Worker's internal URL is only available via accessor
      expect(env.roomoteAppUrl).toBe('https://internal-api.example.com');
    });
  });
});
