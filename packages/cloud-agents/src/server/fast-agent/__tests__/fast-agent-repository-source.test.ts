import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import {
  buildGitAuthenticationEnvironment,
  resolveRepositorySkillCredential,
  resolveRepositorySkillRepositories,
  type RepositorySkillRepository,
} from '../fast-agent-repository-skill-source';
import {
  FastAgentRepositorySource,
  type FastAgentRepositorySourceOptions,
} from '../fast-agent-repository-source';

vi.mock('../fast-agent-repository-skill-source', () => ({
  resolveRepositorySkillRepositories: vi.fn(),
  resolveRepositorySkillCredential: vi.fn(),
  buildGitAuthenticationEnvironment: vi.fn(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const exec = promisify(execFile);
const repository: RepositorySkillRepository = {
  id: 'repo-1',
  fullName: 'test/source',
  defaultBranch: 'main',
  cloneUrl: 'https://example.test/source.git',
  environmentIds: ['allowed'],
  githubRepoId: null,
  installationId: null,
  sourceControlProvider: 'gitlab',
};
let fixture: string;
let revision: string;
const sources: FastAgentRepositorySource[] = [];
let snapshotRoots: string[] = [];

async function fixtureGit(...args: string[]): Promise<string> {
  return (
    await exec(
      'git',
      ['-C', fixture, '-c', 'core.hooksPath=/dev/null', ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: fixture,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    )
  ).stdout.trim();
}

const openSnapshot: NonNullable<
  FastAgentRepositorySourceOptions['openSnapshot']
> = async (_repository, _branch, { directory, git }) => {
  snapshotRoots.push(join(directory, '..'));
  await cp(join(fixture, '.git'), directory, { recursive: true });
  return (await git(['rev-parse', 'HEAD'])).toString().trim();
};

function source(options: Partial<FastAgentRepositorySourceOptions> = {}) {
  const instance = new FastAgentRepositorySource({
    allowedEnvironmentIds: ['allowed'],
    resolveRepositories: async () => [repository],
    openSnapshot,
    ...options,
  });
  sources.push(instance);
  return instance;
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'fast-source-fixture-'));
  await fixtureGit('init', '-b', 'main');
  await fixtureGit('config', 'user.name', 'Test');
  await fixtureGit('config', 'user.email', 'test@example.test');
  for (const directory of ['src', 'unsupported', 'many', 'matches', 'sixteen'])
    await mkdir(join(fixture, directory));
  await writeFile(
    join(fixture, 'src/code.ts'),
    'const value = "a.*b";\nsecond line\nthird line\n',
  );
  await writeFile(
    join(fixture, 'src/executable'),
    '#!/bin/sh\nprintf hello\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(fixture, 'long.txt'),
    'x'.repeat(10_000) + '\n' + 'y\n'.repeat(100),
  );
  await writeFile(
    join(fixture, 'escaped.txt'),
    ('\x01'.repeat(2000) + '\n').repeat(100),
  );
  await writeFile(
    join(fixture, 'unsupported/binary'),
    Buffer.from([65, 0, 66]),
  );
  await writeFile(
    join(fixture, 'unsupported/invalid'),
    Buffer.from([0xc3, 0x28]),
  );
  await writeFile(
    join(fixture, 'unsupported/large'),
    'x'.repeat(256 * 1024 + 1),
  );
  await symlink('../src/code.ts', join(fixture, 'unsupported/link'));
  for (let index = 0; index < 90; index++)
    await writeFile(join(fixture, `many/file-${index}`), 'needle\n');
  for (let index = 0; index < 16; index++)
    await writeFile(join(fixture, `sixteen/file-${index}`), 'needle\n');
  await writeFile(
    join(fixture, 'matches/file'),
    ('prefix needle ' + 'x'.repeat(800) + '\n').repeat(100),
  );
  await fixtureGit('add', '.');
  await fixtureGit('commit', '-m', 'fixture');
  const commit = await fixtureGit('rev-parse', 'HEAD');
  await fixtureGit(
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${commit},unsupported/submodule`,
  );
  await fixtureGit('commit', '-m', 'gitlink');
  revision = await fixtureGit('rev-parse', 'HEAD');
});

beforeEach(() => {
  snapshotRoots = [];
  vi.clearAllMocks();
  vi.mocked(resolveRepositorySkillCredential).mockResolvedValue({
    token: 'secret-token',
    username: 'oauth2',
  });
  vi.mocked(buildGitAuthenticationEnvironment).mockResolvedValue({
    PATH: '/malicious',
    GIT_CONFIG_COUNT: '99',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'secret-shell',
    GIT_DIR: '/secret',
    GIT_EXEC_PATH: '/secret',
    GIT_CONFIG_PARAMETERS: 'secret',
    HTTPS_PROXY: 'https://secret',
    ROOMOTE_FAST_SKILL_GIT_TOKEN: 'secret-token',
    ROOMOTE_FAST_SKILL_GIT_USERNAME: 'oauth2',
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const instance of sources.splice(0)) await instance.dispose();
  for (const root of snapshotRoots)
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  vi.restoreAllMocks();
});

it('inspects a real authenticated smart-HTTP partial clone and lazily reads pinned blobs', async () => {
  const { spawn: backendSpawn } =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  const configPath = join(fixture, '.git/config');
  const config = await readFile(configPath);
  const authorizationHeader = `Basic ${Buffer.from('fixture:only').toString('base64')}`;
  const children = new Map<ReturnType<typeof backendSpawn>, Promise<unknown>>();
  const requests: string[] = [];
  const bodies: Buffer[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorizationHeader) {
      response
        .writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
        .end();
      return;
    }
    requests.push(request.url!);
    const url = new URL(request.url!, 'http://fixture');
    const child = backendSpawn('git', ['http-backend'], {
      detached: true,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: fixture,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: fixture,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method!,
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: request.headers['content-length'] ?? '',
        HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
        REMOTE_USER: 'fixture',
      },
    });
    children.set(child, new Promise((resolve) => child.once('close', resolve)));
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', () => response.destroy());
    request.on('data', (chunk: Buffer) => bodies.push(chunk));
    request.pipe(child.stdin);
    child.stdin.on('error', () => response.destroy());
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const boundary = output.indexOf('\r\n\r\n');
      if (boundary < 0) {
        response.writeHead(502).end();
        return;
      }
      for (const line of output
        .subarray(0, boundary)
        .toString()
        .split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status')
          response.statusCode = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.end(output.subarray(boundary + 4));
    });
  });
  let instance: FastAgentRepositorySource | undefined;
  try {
    await fixtureGit('config', 'uploadpack.allowFilter', 'true');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const cloneUrl = `http://127.0.0.1:${address.port}/.git`;
    vi.mocked(resolveRepositorySkillCredential).mockResolvedValue({
      authorizationHeader,
    });
    vi.mocked(buildGitAuthenticationEnvironment).mockImplementation(
      async (root) => {
        snapshotRoots.push(root);
        return { GIT_CONFIG_VALUE_0: `Authorization: ${authorizationHeader}` };
      },
    );
    instance = source({
      openSnapshot: undefined,
      resolveRepositories: async () => [{ ...repository, cloneUrl }],
    });
    await expect(
      instance.inspect({
        action: 'list',
        repositoryId: repository.id,
        path: 'src',
      }),
    ).resolves.toMatchObject({
      revision,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'src/code.ts' }),
      ]),
    });
    expect(Buffer.concat(bodies).toString()).toContain('filter blob:none');
    const fetched = requests.length;
    await expect(
      instance.inspect({
        action: 'read',
        repositoryId: repository.id,
        path: 'src/code.ts',
        revision,
      }),
    ).resolves.toMatchObject({
      revision,
      content: '1: const value = "a.*b";\n2: second line\n3: third line',
    });
    expect(requests.length).toBeGreaterThan(fetched);
    const hydrated = requests.length;
    await expect(
      instance.inspect({
        action: 'search',
        repositoryId: repository.id,
        path: 'src/code.ts',
        query: 'a.*b',
        revision,
      }),
    ).resolves.toMatchObject({
      revision,
      incomplete: false,
      matches: [expect.objectContaining({ line: 1 })],
    });
    expect(requests).toHaveLength(hydrated);
    expect(await readdir(snapshotRoots[0]!)).toEqual(['repository.git']);
    expect(
      await readFile(join(snapshotRoots[0]!, 'repository.git/config'), 'utf8'),
    ).toMatch(/bare = true/);
    expect(
      vi
        .mocked(spawn)
        .mock.calls.every(([, args]) => !args?.includes('checkout')),
    ).toBe(true);
  } finally {
    await instance?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const child of children.keys()) {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
    await Promise.all(children.values());
    await writeFile(configPath, config);
  }
  for (const root of snapshotRoots)
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);

it('fetches only the configured HTTP branch without checkout or inherited credentials', async () => {
  vi.mocked(resolveRepositorySkillCredential).mockResolvedValue({
    authorizationHeader: 'Bearer secret-token',
  });
  vi.mocked(buildGitAuthenticationEnvironment).mockResolvedValue({
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret-token',
    GIT_CONFIG_COUNT: '99',
    GIT_CONFIG_KEY_1: 'core.sshCommand',
    GIT_CONFIG_VALUE_1: 'secret-shell',
  });
  const fakeSpawn = vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      if (args?.includes('rev-parse')) child.stdout.write(revision + '\n');
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  try {
    await source({
      openSnapshot: undefined,
      resolveRepositories: async () => [
        {
          ...repository,
          cloneUrl: 'https://user:password@example.test/source.git',
        },
      ],
    }).inspect({
      action: 'list',
      repositoryId: repository.id,
      branch: 'feature/source',
    });
    const calls = fakeSpawn.mock.calls;
    expect(
      calls.some(
        ([, args]) =>
          args?.includes('refs/heads/feature/source') &&
          args.includes('--depth=1') &&
          args.includes('--filter=blob:none'),
      ),
    ).toBe(true);
    expect(
      calls.some(([, args]) =>
        args?.includes('https://example.test/source.git'),
      ),
    ).toBe(true);
    for (const [, args, options] of calls) {
      expect(JSON.stringify(args)).not.toMatch(
        /password|secret-token|checkout|setup/,
      );
      expect(options?.env).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret-token',
      });
      expect(options?.env).not.toHaveProperty('GIT_CONFIG_KEY_1');
    }
  } finally {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    fakeSpawn.mockImplementation(actual.spawn);
  }
});

it('keeps this turn pinned when a branch moves and rejects the old SHA in a later turn', async () => {
  const instance = source();
  await instance.inspect({ action: 'list', repositoryId: repository.id });
  const previous = await fixtureGit('rev-parse', 'HEAD^');
  try {
    await fixtureGit('update-ref', 'refs/heads/main', previous);
    await expect(
      instance.inspect({
        action: 'list',
        repositoryId: repository.id,
        revision,
      }),
    ).resolves.toMatchObject({ revision });
    await expect(
      source().inspect({
        action: 'list',
        repositoryId: repository.id,
        revision,
      }),
    ).rejects.toMatchObject({ code: 'revision' });
  } finally {
    await fixtureGit('update-ref', 'refs/heads/main', revision);
  }
});

it.each(['timeout', 'overflow'] as const)(
  'kills the detached process group on %s and sanitizes output',
  async (failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = Object.assign(new EventEmitter(), {
      pid: 987654,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let started!: () => void;
    const spawning = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      started();
      return child as unknown as ReturnType<typeof spawn>;
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    });
    const inspection = source({
      openSnapshot: async (_repo, _branch, { directory, git }) => {
        snapshotRoots.push(join(directory, '..'));
        await git(['init', '--bare']);
        return revision;
      },
    }).inspect({ action: 'list', repositoryId: repository.id });
    const assertion = expect(inspection).rejects.toThrow(
      'Repository snapshot could not be inspected safely.',
    );
    await spawning;
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(60_001);
    else child.stderr.write(Buffer.alloc(2 * 1024 * 1024 + 1, 's'));
    await assertion;
    expect(kill).toHaveBeenCalledWith(-987654, 'SIGKILL');
  },
);

it('fails closed if prlimit is unavailable', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  vi.mocked(spawn).mockImplementationOnce((_command, args, options) =>
    actual.spawn('/nonexistent-prlimit', args!, options!),
  );
  await expect(
    source().inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toThrow('Repository snapshot could not be inspected safely.');
});

it('reports cleanup failures safely and retries them on disposal', async () => {
  const instance = source();
  await instance.inspect({ action: 'list', repositoryId: repository.id });
  vi.mocked(rm).mockRejectedValueOnce(new Error('secret filesystem path'));
  await expect(instance.dispose()).rejects.toThrow(
    'Repository snapshot cleanup failed.',
  );
  await expect(instance.dispose()).resolves.toBeUndefined();
});
afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

it('reads real Git blobs at the returned revision with literal paths and hardened commands', async () => {
  const instance = source();
  await expect(
    instance.inspect({
      action: 'read',
      repositoryId: repository.id,
      path: 'src/code.ts',
      startLine: 2,
      limit: 1,
    }),
  ).resolves.toMatchObject({
    revision,
    repository: { id: repository.id, branch: 'main' },
    scope: 'src/code.ts',
    tested: false,
    mode: 'source-only',
    content: '2: second line',
    nextStartLine: 3,
  });
  await expect(
    instance.inspect({
      action: 'read',
      repositoryId: repository.id,
      path: 'src/executable',
      revision,
    }),
  ).resolves.toMatchObject({ content: '1: #!/bin/sh\n2: printf hello' });
  for (const [command, args, options] of vi.mocked(spawn).mock.calls) {
    expect(command).toBe('/usr/bin/prlimit');
    expect(args).toEqual(
      expect.arrayContaining([
        '--fsize=16777216',
        '--as=536870912',
        '--cpu=30',
        '--',
        'git',
        'credential.helper=',
        'http.followRedirects=false',
        'protocol.allow=never',
        'fetch.unpackLimit=1',
      ]),
    );
    expect(options).toMatchObject({
      detached: true,
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'http:https',
        GIT_LITERAL_PATHSPECS: '1',
        ROOMOTE_FAST_SKILL_GIT_TOKEN: 'secret-token',
      },
    });
    expect(options?.env).not.toHaveProperty('GIT_EXEC_PATH');
    expect(options?.env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
    expect(options?.env).not.toHaveProperty('HTTPS_PROXY');
    expect(options?.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(args).not.toContain('-l');
    expect(args).not.toContain('show');
  }
});

it('lists bounded entries and searches literal text, not regular expressions', async () => {
  const instance = source();
  await expect(
    instance.inspect({
      action: 'list',
      repositoryId: repository.id,
      path: 'many',
    }),
  ).resolves.toMatchObject({
    truncated: true,
    guidance: expect.stringContaining('Narrow'),
  });
  const listing = await instance.inspect({
    action: 'list',
    repositoryId: repository.id,
    path: 'src',
    limit: 1,
  });
  expect(listing).toMatchObject({
    entries: [expect.objectContaining({ path: 'src/code.ts' })],
    truncated: true,
  });
  expect(listing).not.toHaveProperty('nextOffset');
  await expect(
    instance.inspect({
      action: 'search',
      repositoryId: repository.id,
      path: 'src/code.ts',
      query: 'a.*b',
    }),
  ).resolves.toMatchObject({
    matches: [
      {
        path: 'src/code.ts',
        line: 1,
        preview: 'const value = "a.*b";',
        previewTruncated: false,
      },
    ],
    incomplete: false,
  });
  await expect(
    instance.inspect({
      action: 'search',
      repositoryId: repository.id,
      path: 'many',
      query: 'needle',
    }),
  ).rejects.toMatchObject({ code: 'scope' });
});

it('pins cached snapshots and rejects expected revisions from another turn or branch', async () => {
  const opener = vi.fn(openSnapshot);
  const instance = source({ openSnapshot: opener });
  await instance.inspect({ action: 'list', repositoryId: repository.id });
  await instance.inspect({
    action: 'list',
    repositoryId: repository.id,
    revision,
  });
  expect(opener).toHaveBeenCalledTimes(1);
  await expect(
    instance.inspect({
      action: 'list',
      repositoryId: repository.id,
      revision: 'f'.repeat(40),
    }),
  ).rejects.toMatchObject({ code: 'revision' });
  const nextTurn = source();
  await expect(
    nextTurn.inspect({
      action: 'list',
      repositoryId: repository.id,
      revision: 'a'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'revision' });
});

it('rechecks exact authorization before cached use and filters injected environments', async () => {
  const resolver = vi.fn().mockResolvedValue([repository]);
  const instance = source({ resolveRepositories: resolver });
  await instance.inspect({ action: 'list', repositoryId: repository.id });
  const commands = vi.mocked(spawn).mock.calls.length;
  resolver.mockResolvedValue([
    { ...repository, environmentIds: ['forbidden'] },
  ]);
  await expect(
    instance.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toThrow('Unknown Fast repository.');
  expect(vi.mocked(spawn).mock.calls).toHaveLength(commands);
  expect(resolver).toHaveBeenLastCalledWith(['allowed']);
  await expect(lstat(snapshotRoots[0]!)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const empty = source({ allowedEnvironmentIds: [] });
  await expect(
    empty.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toThrow('Unknown Fast repository.');
});

it('uses the shared resolver restricted to the allowed environments', async () => {
  vi.mocked(resolveRepositorySkillRepositories).mockResolvedValue([repository]);
  await source({ resolveRepositories: undefined }).inspect({
    action: 'list',
    repositoryId: repository.id,
  });
  expect(resolveRepositorySkillRepositories).toHaveBeenCalledWith(['allowed']);
});

it.each([
  '../secret',
  '/absolute',
  './src',
  'src/../code.ts',
  'src//code.ts',
  'src\\code.ts',
  'src/\u0000file',
  'src/',
])('rejects noncanonical path %j before transport', async (path) => {
  await expect(
    source().inspect({ action: 'read', repositoryId: repository.id, path }),
  ).rejects.toMatchObject({ code: 'arguments' });
  expect(resolveRepositorySkillCredential).not.toHaveBeenCalled();
});

it.each([
  'main:secret',
  'main~1',
  'main^',
  '?',
  '*',
  '[main]',
  'a\\b',
  'a\nb',
  'a..b',
  'a@{b',
  '-main',
  'main/',
  'main.',
  'a.lock',
  'a/.hidden',
  'a//b',
])('rejects unsafe branch %j', async (branch) => {
  await expect(
    source().inspect({ action: 'list', repositoryId: repository.id, branch }),
  ).rejects.toMatchObject({ code: 'arguments' });
  expect(resolveRepositorySkillCredential).not.toHaveBeenCalled();
});

it.each([
  { action: 'read' },
  { action: 'search' },
  { action: 'search', query: 'x'.repeat(201) },
  { action: 'list', limit: 81 },
  { action: 'read', path: 'src/code.ts', startLine: 0 },
  { action: 'list', revision: 'abcdef' },
  { action: 'list', url: 'https://evil.test' },
])('rejects invalid arguments %j', async (args) => {
  await expect(
    source().inspect({ repositoryId: repository.id, ...args }),
  ).rejects.toMatchObject({ code: 'arguments' });
});

it.each(['link', 'submodule', 'binary', 'invalid', 'large'])(
  'rejects unsupported source %s',
  async (name) => {
    await expect(
      source().inspect({
        action: 'read',
        repositoryId: repository.id,
        path: `unsupported/${name}`,
      }),
    ).rejects.toMatchObject({
      code: ['link', 'submodule'].includes(name) ? 'scope' : 'text',
    });
  },
);

it('reports skipped files rather than claiming a complete search', async () => {
  await expect(
    source().inspect({
      action: 'search',
      repositoryId: repository.id,
      path: 'unsupported',
      query: 'needle',
    }),
  ).resolves.toMatchObject({
    matches: [],
    skippedFiles: 5,
    scannedFiles: 0,
    unscannedFiles: 0,
    incomplete: true,
  });
});

it('bounds numbered reads and reports long-line truncation and continuation', async () => {
  const instance = source();
  const result = await instance.inspect({
    action: 'read',
    repositoryId: repository.id,
    path: 'long.txt',
  });
  expect(result).toMatchObject({
    truncated: true,
    truncatedLines: [1],
    nextStartLine: 81,
  });
  expect(JSON.stringify(result)).toContain('[line truncated]');
  const escaped = await instance.inspect({
    action: 'read',
    repositoryId: repository.id,
    path: 'escaped.txt',
  });
  expect(escaped).toMatchObject({
    truncated: true,
    nextStartLine: expect.any(Number),
  });
  expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(50 * 1024);
  expect(JSON.stringify(escaped, null, 2).split('\n').length).toBeLessThan(
    2000,
  );
});

it('bounds search matches and preview lengths with explicit incompleteness', async () => {
  const result = await source().inspect({
    action: 'search',
    repositoryId: repository.id,
    path: 'matches',
    query: 'needle',
  });
  expect(result).toMatchObject({
    truncated: true,
    incomplete: true,
    matches: expect.arrayContaining([
      expect.objectContaining({ previewTruncated: true }),
    ]),
  });
  const matches = (result as { matches: { preview: string }[] }).matches;
  expect(matches.length).toBeLessThanOrEqual(50);
  expect(matches.every((match) => match.preview.length <= 400)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1024);
});

it('serializes concurrent inspection, limits snapshots to two, and cleans on exhaustion', async () => {
  const opener = vi.fn(openSnapshot);
  const instance = source({ openSnapshot: opener });
  await Promise.all([
    instance.inspect({ action: 'list', repositoryId: repository.id }),
    instance.inspect({ action: 'list', repositoryId: repository.id }),
  ]);
  expect(opener).toHaveBeenCalledTimes(1);
  await instance.inspect({
    action: 'list',
    repositoryId: repository.id,
    branch: 'other',
  });
  await expect(
    instance.inspect({
      action: 'list',
      repositoryId: repository.id,
      branch: 'third',
    }),
  ).rejects.toMatchObject({ code: 'budget' });
  expect(opener).toHaveBeenCalledTimes(2);
});

it('enforces a 20-call external inspection budget and disposes resources', async () => {
  const resolver = vi.fn().mockResolvedValue([repository]);
  const instance = source({ resolveRepositories: resolver });
  let failure: unknown;
  for (let index = 0; index < 21; index++) {
    try {
      await instance.inspect({ action: 'list', repositoryId: repository.id });
    } catch (error) {
      failure = error;
      break;
    }
  }
  expect(failure).toMatchObject({ code: 'budget' });
  expect(resolver).toHaveBeenCalledTimes(20);
});

it('can search all 16 allowed regular files within one tool call', async () => {
  await expect(
    source().inspect({
      action: 'search',
      repositoryId: repository.id,
      path: 'sixteen',
      query: 'needle',
    }),
  ).resolves.toMatchObject({
    scannedFiles: 16,
    unscannedFiles: 0,
    skippedFiles: 0,
    incomplete: false,
  });
});

it('fails closed on oversized snapshots and sanitizes injected and Git errors', async () => {
  const oversized = source({
    openSnapshot: async (...args) => {
      const sha = await openSnapshot(...args);
      await writeFile(
        join(args[2].directory, 'oversized'),
        Buffer.alloc(32 * 1024 * 1024),
      );
      return sha;
    },
  });
  await expect(
    oversized.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toMatchObject({ code: 'budget' });
  const broken = source({
    openSnapshot: async (_repo, _branch, context) => {
      snapshotRoots.push(join(context.directory, '..'));
      throw new Error('secret-token https://private.example/secret');
    },
  });
  await expect(
    broken.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toThrow('Repository snapshot could not be inspected safely.');
  const invalidGit = source({
    openSnapshot: async (_repo, _branch, context) => {
      snapshotRoots.push(join(context.directory, '..'));
      await context.git(['not-a-command-secret-token']);
      return revision;
    },
  });
  await expect(
    invalidGit.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toThrow('Repository snapshot could not be inspected safely.');
});

it('rejects non-HTTP configured transports even with an injected opener', async () => {
  const opener = vi.fn(openSnapshot);
  await expect(
    source({
      resolveRepositories: async () => [
        { ...repository, cloneUrl: 'file:///tmp/private' },
      ],
      openSnapshot: opener,
    }).inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toMatchObject({ code: 'transport' });
  expect(opener).not.toHaveBeenCalled();
});

it('waits for queued operations before disposing and rejects subsequent use', async () => {
  const instance = source();
  const pending = instance.inspect({
    action: 'list',
    repositoryId: repository.id,
  });
  const disposed = instance.dispose();
  await pending;
  await disposed;
  await expect(
    instance.inspect({ action: 'list', repositoryId: repository.id }),
  ).rejects.toMatchObject({ code: 'disposed' });
});
