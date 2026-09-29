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
const exec = promisify(execFile);
let cwd: string;
const env = {
  ...process.env,
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
  await rm(cwd, { recursive: true, force: true });
});
it('uses scoped credentials and sends bounded evidence with cancellation', async () => {
  const report = await checkRepositoryJudgement(env, cwd);
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
        { ...env, ROOMOTE_CLOUD_TOKEN: undefined },
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
