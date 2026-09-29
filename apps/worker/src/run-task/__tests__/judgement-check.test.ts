import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const { mutate, createClientMock, headersMock } = vi.hoisted(() => ({
  mutate: vi.fn(),
  createClientMock: vi.fn(),
  headersMock: vi.fn(),
}));
vi.mock('@roomote/sdk/client', () => ({
  createClient: createClientMock,
  buildWorkerHeaders: headersMock,
}));
import { checkRepositoryJudgement } from '../judgement-check';
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
    taskRuns: { evaluateRepositoryJudgement: { mutate } },
  });
  mutate.mockResolvedValue({
    kind: 'answered',
    answer: { outcome: 'violation', confidence: 0.99 },
  });
  proxy = await startJudgementProxy(env);
  env.R_JUDGEMENT_GATEWAY_URL = proxy.endpoint;
  cwd = await mkdtemp(join(tmpdir(), 'roomote-judgement-'));
  await exec('git', ['init', '-q'], { cwd });
  await writeFile(
    join(cwd, 'JUDGE.json'),
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
  await exec('git', ['rm', '-f', 'JUDGE.json'], { cwd });
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
  const runtimeEnv = { ...env, R_JUDGEMENT_GATEWAY_URL: 'stale' };
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
    runtimeEnv,
  );
  expect(terminal).toEqual({
    PATH: '/bin',
    R_JUDGEMENT_GATEWAY_URL: runtimeEnv.R_JUDGEMENT_GATEWAY_URL,
  });
  await close?.();
  await expect(fetch(runtimeEnv.R_JUDGEMENT_GATEWAY_URL)).rejects.toThrow();
  const warn = vi.fn();
  await setupJudgement({
    runtimeEnv: Object.assign(runtimeEnv, { ROOMOTE_CLOUD_TOKEN: '' }),
    logger: { warn },
    registerCleanup: vi.fn(),
  });
  expect(runtimeEnv.R_JUDGEMENT_GATEWAY_URL).toBeUndefined();
  expect(warn).toHaveBeenCalled();
});
