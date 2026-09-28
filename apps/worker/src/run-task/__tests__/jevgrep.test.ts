import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  install: vi.fn(),
  root: '',
}));
vi.mock('@roomote/sdk/client', () => ({
  sdk: { taskRuns: { isJevgrepEnabled: mocks.enabled } },
}));
vi.mock('execa', () => ({ execa: mocks.install }));
vi.mock('@roomote/types', async (original) => ({
  ...(await original<typeof import('@roomote/types')>()),
  resolveWorkerRuntimePaths: () => ({ sandboxRootDir: mocks.root }),
}));
vi.mock('../../commands/setup/npm-install-command', () => ({
  resolveNpmInstallCommand: async () => ({ command: 'npm', argsPrefix: [] }),
}));

import { setupJevgrep } from '../jevgrep';

let homeDir: string;
let runtimeEnv: Record<string, string>;
const logger = { warn: vi.fn() };
const setup = () =>
  setupJevgrep({
    runId: 42,
    homeDir,
    runtimeEnv,
    logger,
    trpcUrl: 'https://roomote.example',
  });

beforeEach(() => {
  vi.clearAllMocks();
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-jg-'));
  mocks.root = path.join(homeDir, 'sandbox');
  runtimeEnv = { PATH: '/usr/bin', ROOMOTE_CLOUD_TOKEN: 'run-token' };
  mocks.enabled.mockResolvedValue(true);
  mocks.install.mockImplementation(async () => {
    const root = path.join(
      mocks.root,
      'jevgrep-cli/node_modules/@dzhng/jevgrep',
    );
    fs.mkdirSync(path.join(root, 'dist/bin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ version: '0.4.1', type: 'module' }),
    );
    fs.writeFileSync(
      path.join(root, 'dist/bin/index.js'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      const auth = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'jevgrep/credentials.json')));
      await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { authorization: 'Bearer ' + auth.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'source', questions: { relevant: { type: 'noul', instructions: 'Relevant?' } } }),
      });
    `,
    );
  });
});
afterEach(() => fs.rmSync(homeDir, { recursive: true, force: true }));

it('installs and routes the CLI through the gateway with run auth and auth bypass', async () => {
  expect(await setup()).toBe(true);
  expect(mocks.enabled).toHaveBeenCalledWith({ runId: 42 });
  expect(mocks.install.mock.calls[0]?.[1]).toContain('@dzhng/jevgrep@0.4.1');
  const root = path.join(homeDir, '.roomote/jevgrep');
  const credentials = fs.readFileSync(
    path.join(root, 'config/jevgrep/credentials.json'),
    'utf8',
  );
  expect(credentials).not.toContain('run-token');
  const bootstrap = path.join(homeDir, 'fetch.mjs');
  fs.writeFileSync(
    bootstrap,
    `globalThis.fetch = async (url, init) => {
    console.log(JSON.stringify({ url, ...init, headers: Object.fromEntries(init.headers) }));
    return new Response('{}');
  };`,
  );
  const result = JSON.parse(
    execFileSync(path.join(root, 'bin/jg'), ['question'], {
      env: {
        ...runtimeEnv,
        NODE_OPTIONS: `--import ${JSON.stringify(bootstrap)}`,
        ROOMOTE_AUTH_BYPASS_VALUE: 'bypass',
      },
      encoding: 'utf8',
    }),
  );
  expect(result.url).toBe(
    'https://roomote.example/api/inference/jevgrep/v1/systemone',
  );
  expect(result.headers.authorization).toBe('Bearer run-token');
  expect(result.headers['x-bypass-roomote-auth']).toBe('bypass');
  expect(JSON.parse(result.body).state).toBe('source');
  expect(result.redirect).toBe('error');
  expect(await setup()).toBe(true);
  expect(mocks.install).toHaveBeenCalledTimes(1);
});

it('removes stale setup and does not install when Jev is disabled', async () => {
  await setup();
  mocks.enabled.mockResolvedValue(false);
  expect(await setup()).toBe(false);
  expect(runtimeEnv.R_JEVGREP_GATEWAY_URL).toBeUndefined();
  expect(runtimeEnv.PATH).toBe('/usr/bin');
  expect(fs.existsSync(path.join(homeDir, '.roomote/jevgrep'))).toBe(false);
  expect(mocks.install).toHaveBeenCalledTimes(1);
});

it.each(['config', 'install'])(
  'falls back without exposing %s failure details',
  async (failure) => {
    (failure === 'config'
      ? mocks.enabled
      : mocks.install
    ).mockRejectedValueOnce(new Error('private-key'));
    expect(await setup()).toBe(false);
    expect(runtimeEnv.R_JEVGREP_GATEWAY_URL).toBeUndefined();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-key');
  },
);
