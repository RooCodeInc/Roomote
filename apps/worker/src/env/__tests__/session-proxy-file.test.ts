import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionProxyEnvFile } from '../session-proxy-file';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-proxy-reload-'));
  directories.push(dir);
  const path = join(dir, 'session-services.env');
  const unchangedParentEnv = {
    PATH: process.env.PATH,
    BASH_ENV: path,
    KEEP_ME: 'unrelated',
    ROOMOTE_SERVICE_TOKEN_STALE: 'rses_stale',
  };
  const read = () =>
    JSON.parse(
      execFileSync(
        '/bin/bash',
        [
          '-c',
          '"$1" -p "JSON.stringify({a:process.env.ROOMOTE_SERVICE_TOKEN_A,b:process.env.ROOMOTE_SERVICE_TOKEN_B,stale:process.env.ROOMOTE_SERVICE_TOKEN_STALE,keep:process.env.KEEP_ME})"',
          'session-config-test',
          process.execPath,
        ],
        {
          env: unchangedParentEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  return { path, read };
}

it('makes a first approval visible to new clients of the same already-running parent environment', () => {
  const { path, read } = fixture();
  writeSessionProxyEnvFile(path, {});
  expect(read()).toEqual({ keep: 'unrelated' });
  writeSessionProxyEnvFile(path, {
    ROOMOTE_SERVICE_TOKEN_A: 'rses_first',
    KEEP_ME: 'must-not-replace',
  });
  expect(read()).toEqual({ a: 'rses_first', keep: 'unrelated' });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('adds a second grant and removes stale scoped values without changing the parent environment', () => {
  const { path, read } = fixture();
  writeSessionProxyEnvFile(path, { ROOMOTE_SERVICE_TOKEN_A: 'rses_first' });
  expect(read()).toEqual({ a: 'rses_first', keep: 'unrelated' });
  writeSessionProxyEnvFile(path, {
    ROOMOTE_SERVICE_TOKEN_A: 'rses_first',
    ROOMOTE_SERVICE_TOKEN_B: 'rses_second',
  });
  expect(read()).toEqual({
    a: 'rses_first',
    b: 'rses_second',
    keep: 'unrelated',
  });
  writeSessionProxyEnvFile(path, { ROOMOTE_SERVICE_TOKEN_B: 'rses_second' });
  expect(read()).toEqual({ b: 'rses_second', keep: 'unrelated' });
});

it.each([
  '/bin/sh',
  '/bin/bash',
  ...(existsSync('/bin/zsh') ? ['/bin/zsh'] : []),
])(
  'loads portably in %s without changing shell semantics or unrelated env',
  (shell) => {
    const { path } = fixture();
    writeSessionProxyEnvFile(path, { ROOMOTE_SERVICE_TOKEN_A: 'rses_current' });
    const result = JSON.parse(
      execFileSync(
        shell,
        [
          '-c',
          'IFS=:; . "$1" || exit 1; export TEST_IFS="$IFS"; "$2" -p \'JSON.stringify({a:process.env.ROOMOTE_SERVICE_TOKEN_A,old:process.env.ROOMOTE_SERVICE_TOKEN_OLD,old2:process.env.ROOMOTE_SERVICE_TOKEN_OLD_TWO,keep:process.env.KEEP_ME,ifs:process.env.TEST_IFS})\'',
          'loader-test',
          path,
          process.execPath,
        ],
        {
          env: {
            PATH: process.env.PATH,
            KEEP_ME: 'unrelated',
            ROOMOTE_SERVICE_TOKEN_OLD: 'rses_old',
            ROOMOTE_SERVICE_TOKEN_OLD_TWO: 'rses_old_two',
          },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
    expect(result).toEqual({ a: 'rses_current', keep: 'unrelated', ifs: ':' });
  },
);
