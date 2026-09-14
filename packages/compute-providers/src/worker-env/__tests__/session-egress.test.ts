vi.mock('@roomote/env', () => ({
  Env: {
    R_APP_URL: 'https://web.roomote.example.com',
    TRPC_URL: 'https://api.roomote.example.com',
  },
}));

import { buildBaseWorkerEnv } from '../base';
import {
  buildAzureWorkerEnv,
  buildBlaxelWorkerEnv,
  buildBoxWorkerEnv,
  buildDaytonaWorkerEnv,
  buildDockerWorkerEnv,
  buildE2bWorkerEnv,
  buildModalWorkerEnv,
} from '../index';

describe.each([
  ['base', buildBaseWorkerEnv],
  ['Docker', buildDockerWorkerEnv],
  ['Modal', buildModalWorkerEnv],
  ['Azure', buildAzureWorkerEnv],
  ['Blaxel', buildBlaxelWorkerEnv],
  ['Box', buildBoxWorkerEnv],
  ['Daytona', buildDaytonaWorkerEnv],
  ['E2B', buildE2bWorkerEnv],
] as const)('%s session egress env isolation', (_provider, buildWorkerEnv) => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each(['R_SESSION_EGRESS_GATEWAY_TOKEN', 'SESSION_EGRESS_GATEWAY_TOKEN'])(
    'hard-denies %s through either forwarding path',
    (key) => {
      const sentinel = `service-only-sentinel-${key}`;
      const allowedEnv = {
        CUSTOM_PROVIDER_API_KEY: 'custom-provider-sentinel',
        GH_TOKEN: 'rses_0123456789abcdefghijklmnopqrstuvwxyz0123456789',
      };
      const options = {
        authToken: 'run-scoped-auth-sentinel',
        baseImageRef: 'test-image',
        diskImage: 'test-image',
        image: 'test-image',
        snapshotName: 'test-snapshot',
        templateId: 'test-template',
      };

      process.env.R_MODEL_ENV_KEYS = [key, ...Object.keys(allowedEnv)].join(
        ',',
      );
      Object.assign(process.env, allowedEnv, { [key]: sentinel });
      const operatorEnv = buildWorkerEnv(options);

      process.env = {};
      const extraEnv = buildWorkerEnv({
        ...options,
        extraEnv: { ...allowedEnv, [key]: sentinel },
      });

      for (const env of [operatorEnv, extraEnv]) {
        expect.soft(env).not.toHaveProperty(key);
        expect.soft(JSON.stringify(env)).not.toContain(sentinel);
        expect.soft(env).toMatchObject({
          ...allowedEnv,
          AUTH_TOKEN: options.authToken,
        });
      }
    },
  );
});
