import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const { mutate, createClientMock, headersMock, enabled, resolveCli } =
  vi.hoisted(() => ({
    mutate: vi.fn(),
    enabled: vi.fn(),
    resolveCli: vi.fn(),
    createClientMock: vi.fn(),
    headersMock: vi.fn(),
  }));
vi.mock('@roomote/sdk/client', () => ({
  createClient: createClientMock,
  buildWorkerHeaders: headersMock,
}));
vi.mock('../repository-judgement', () => ({ resolveJudgementCli: resolveCli }));
import { runCli } from '@roo-code/judgement';
import {
  evaluateTaskJudgement,
  checkRepositoryJudgement,
} from '../judgement-check';
import {
  startJudgementProxy,
  buildJudgementTerminalEnv,
  setupJudgement,
} from '../judgement-proxy';
let proxy: Awaited<ReturnType<typeof startJudgementProxy>>;
const exec = promisify(execFile);
let cwd: string;
const env = {
  R_JUDGEMENT_GATEWAY_URL: '',
  ROOMOTE_TASK_RUN_ID: '42',
  ROOMOTE_PLATFORM_API_URL: 'https://example.test',
  ROOMOTE_CLOUD_TOKEN: 'run-token',
  ROOMOTE_AUTH_BYPASS_VALUE: 'bypass',
  ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-custom-bypass',
  AUTH_TOKEN: 'launcher-token-must-not-be-used',
};
beforeEach(async () => {
  vi.clearAllMocks();
  createClientMock.mockReturnValue({
    taskRuns: {
      evaluateRepositoryJudgement: { mutate },
      isRepositoryJudgementEnabled: { query: enabled },
    },
  });
  mutate.mockResolvedValue({
    kind: 'answered',
    answer: { outcome: 'violation', confidence: 0.99 },
  });
  proxy = await startJudgementProxy(env);
  env.R_JUDGEMENT_GATEWAY_URL = proxy.endpoint;
  cwd = await mkdtemp(join(tmpdir(), 'roomote-judgement-'));
  await exec('git', ['init', '-q'], { cwd });
  await mkdir(join(cwd, '.judgement'));
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({ criteria: [{ rule: 'Use sentence case' }] }),
  );
  await writeFile(join(cwd, 'example.ts'), 'changed');
  await exec('git', ['add', '.'], { cwd });
});
afterEach(async () => {
  await proxy.close();
  await rm(cwd, { recursive: true, force: true });
});
it('uses scoped credentials and sends bounded evidence with cancellation', async () => {
  const report = await checkRepositoryJudgement(
    { R_JUDGEMENT_GATEWAY_URL: proxy.endpoint },
    cwd,
    { deadlineMs: 10_000 },
  );
  expect(report.status).toBe('violation');
  const options = createClientMock.mock.calls[0]![0];
  options.headers();
  expect(options.url).toBe('https://example.test');
  expect(headersMock).toHaveBeenCalledWith({
    AUTH_TOKEN: 'run-token',
    ROOMOTE_AUTH_BYPASS_VALUE: 'bypass',
    ROOMOTE_AUTH_BYPASS_HEADER_NAME: 'x-custom-bypass',
  });
  expect(mutate).toHaveBeenCalledWith(
    {
      runId: 42,
      request: expect.objectContaining({
        kind: 'judge',
        focusPaths: ['example.ts'],
      }),
    },
    { signal: expect.any(AbortSignal) },
  );
});
it('reports unavailable models and missing runtime credentials as incomplete', async () => {
  mutate.mockResolvedValue({ kind: 'unavailable' });
  expect((await checkRepositoryJudgement(env, cwd)).status).toBe('incomplete');
  mutate.mockClear();
  expect(
    (
      await checkRepositoryJudgement(
        { R_JUDGEMENT_GATEWAY_URL: undefined },
        cwd,
      )
    ).status,
  ).toBe('incomplete');
  expect(mutate).not.toHaveBeenCalled();
});
it('does not send a model request without a repository policy', async () => {
  await exec('git', ['rm', '-f', '.judgement/rules.json'], { cwd });
  expect((await checkRepositoryJudgement(env, cwd)).status).toBe('pass');
  expect(mutate).not.toHaveBeenCalled();
});

it('rejects browser requests and oversized evidence without forwarding credentials', async () => {
  mutate.mockClear();
  const browser = await fetch(proxy.endpoint, {
    method: 'POST',
    headers: {
      origin: 'https://example.test',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(browser.status).toBe(403);
  const large = await fetch(proxy.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(23_001),
  });
  expect(large.status).toBe(413);
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps private backend errors out of hook diagnostics', async () => {
  mutate.mockRejectedValue(new Error('private-run-bearer'));
  const report = await checkRepositoryJudgement(
    { R_JUDGEMENT_GATEWAY_URL: proxy.endpoint },
    cwd,
  );
  expect(report.status).toBe('incomplete');
  expect(JSON.stringify(report)).not.toContain('private-run-bearer');
  expect(report.messages.join(' ')).toContain('Roomote');
});

it('clears stale endpoints and registers task cleanup', async () => {
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    R_JUDGEMENT_GATEWAY_URL: 'stale',
  };
  let close: (() => Promise<void>) | undefined;
  await setupJudgement({
    runtimeEnv,
    logger: console,
    registerCleanup: (cleanup) => {
      close = cleanup;
    },
  });
  expect(runtimeEnv.R_JUDGEMENT_GATEWAY_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const terminal = buildJudgementTerminalEnv(
    {
      PATH: '/bin',
      R_JUDGEMENT_GATEWAY_URL: 'untrusted',
      ROOMOTE_CLOUD_TOKEN: 'private-token',
      ROOMOTE_AUTH_BYPASS_VALUE: 'private-bypass',
    },
    runtimeEnv as Record<string, string>,
  );
  expect(terminal).toEqual({
    PATH: '/bin',
    R_JUDGEMENT_GATEWAY_URL: runtimeEnv.R_JUDGEMENT_GATEWAY_URL,
    R_JUDGEMENT_MANAGED: '1',
  });
  await close?.();
  await expect(fetch(runtimeEnv.R_JUDGEMENT_GATEWAY_URL!)).rejects.toThrow();
  const warn = vi.fn();
  await setupJudgement({
    runtimeEnv: Object.assign(runtimeEnv, { ROOMOTE_CLOUD_TOKEN: '' }),
    logger: { warn },
    registerCleanup: vi.fn(),
  });
  expect(runtimeEnv.R_JUDGEMENT_GATEWAY_URL).toBeUndefined();
  expect(warn).toHaveBeenCalled();
  expect(runtimeEnv.R_JUDGEMENT_MANAGED).toBe('1');
  expect(
    buildJudgementTerminalEnv({}, runtimeEnv as Record<string, string>),
  ).toEqual({ R_JUDGEMENT_MANAGED: '1' });
  expect(buildJudgementTerminalEnv({ R_JUDGEMENT_MANAGED: '1' }, {})).toEqual(
    {},
  );
});

it('offers the full CLI only when configured, and removes commands when configuration is disabled', async () => {
  const cli = join(cwd, 'bundled-cli.mjs');
  await writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)))');
  resolveCli.mockReturnValue(cli);
  enabled.mockResolvedValue(true);
  const runtimeEnv = { ...env, PATH: '/bin' };
  const cleanups: (() => Promise<void>)[] = [];
  const options = {
    runtimeEnv,
    homeDir: cwd,
    logger: { warn: vi.fn() },
    registerCleanup: (close: () => Promise<void>) => cleanups.push(close),
  };
  try {
    expect(await setupJudgement(options)).toBe(true);
    expect(enabled).toHaveBeenCalledWith(
      { runId: 42 },
      { signal: expect.any(AbortSignal) },
    );
    const terminal = buildJudgementTerminalEnv(
      { PATH: '/bin' },
      runtimeEnv,
      cwd,
    );
    const launcher = join(cwd, '.roomote/judgement/bin/judgement');
    const result = await exec(launcher, ['test', '--rule', 'criterion_1'], {
      env: terminal,
    });
    expect(JSON.parse(result.stdout)).toEqual([
      'test',
      '--rule',
      'criterion_1',
    ]);
    expect(terminal.PATH).toContain(join(cwd, '.roomote/judgement/bin'));
    expect(terminal).not.toHaveProperty('ROOMOTE_CLOUD_TOKEN');
    enabled.mockResolvedValue(false);
    expect(await setupJudgement(options)).toBe(false);
    await expect(access(launcher)).rejects.toThrow();
    enabled.mockRejectedValue(new Error('private-configuration-details'));
    expect(await setupJudgement(options)).toBe(false);
    expect(JSON.stringify(options.logger.warn.mock.calls)).not.toContain(
      'private-configuration-details',
    );
  } finally {
    await Promise.all(cleanups.map((close) => close()));
  }
});

it('runs shared rule examples through the task proxy without exposing credentials', async () => {
  await mkdir(join(cwd, '.judgement/examples'));
  await writeFile(
    join(cwd, '.judgement/examples/criterion_1.json'),
    JSON.stringify({
      ruleId: 'criterion_1',
      examples: [
        {
          name: 'capital',
          path: 'example.ts',
          before: 'session',
          after: 'Session',
          expected: 'violation',
        },
      ],
    }),
  );
  const stdout: string[] = [];
  const code = await runCli(
    ['test', '--rule', 'criterion_1', '--repeats', '1', '--format', 'json'],
    {
      cwd,
      stdout: (value) => {
        stdout.push(value);
      },
      evaluate: (request, signal) =>
        evaluateTaskJudgement(request, signal, env),
    },
  );
  expect(code).toBe(0);
  expect(JSON.parse(stdout.join('')).status).toBe('pass');
  expect(mutate).toHaveBeenCalled();
});
