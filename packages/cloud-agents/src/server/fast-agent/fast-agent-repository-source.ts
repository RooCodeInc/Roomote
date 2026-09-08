import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  buildGitAuthenticationEnvironment,
  resolveRepositorySkillCredential,
  resolveRepositorySkillRepositories,
  type RepositorySkillRepository,
} from './fast-agent-repository-skill-source';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const MAX_BLOB = 256 * 1024;
const MAX_DISK = 32 * 1024 * 1024;
const MAX_OUTPUT = 48 * 1024;

function validPath(path: string): boolean {
  return (
    path === '' ||
    (path.length <= 1024 &&
      !/[\\\x00-\x1f\x7f]/u.test(path) &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'))
  );
}

function validBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    branch !== '@' &&
    !/[:~^?*[\\\s\x00-\x1f\x7f]/u.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    branch
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          !part.startsWith('.') &&
          !part.startsWith('-') &&
          !part.endsWith('.') &&
          !part.endsWith('.lock'),
      )
  );
}

export const fastAgentRepositoryInspectSchema = z
  .object({
    action: z.enum(['list', 'read', 'search']),
    repositoryId: z.string().min(1).max(200),
    branch: z.string().refine(validBranch).optional(),
    revision: z.string().regex(SHA).optional(),
    path: z.string().refine(validPath).default(''),
    query: z.string().min(1).max(200).optional(),
    startLine: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(1),
    limit: z.number().int().min(1).max(80).default(80),
  })
  .strict()
  .superRefine((args, context) => {
    if (
      (args.action === 'read' && !args.path) ||
      (args.action === 'search' && !args.query)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Missing required scope.',
      });
    }
  });

const messages = {
  arguments: 'Invalid repository inspection arguments.',
  authorization: 'Unknown Fast repository.',
  revision:
    'Repository revision does not match the pinned snapshot. Inspect again without an expected revision to discover the current snapshot.',
  scope:
    'Source is unavailable in this scope. Use an exact regular file or narrower directory.',
  text: 'Source is not a supported UTF-8 text file or exceeds 256 KiB.',
  budget:
    'Repository inspection budget exceeded. Delegate further inspection to a workspace task.',
  transport: 'Repository snapshot could not be inspected safely.',
  cleanup: 'Repository snapshot cleanup failed.',
  disposed: 'Repository source is disposed.',
} as const;

export class FastAgentRepositorySourceError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'FastAgentRepositorySourceError';
  }
}

type Git = (args: string[]) => Promise<Buffer>;
type Snapshot = { revision: string; git: Git; identity: string };
type Entry = { mode: string; type: string; oid: string; path: string };

export type FastAgentRepositorySourceOptions = {
  allowedEnvironmentIds: string[];
  resolveRepositories?: (
    allowedEnvironmentIds: string[],
  ) => Promise<RepositorySkillRepository[]>;
  /** Trusted test seam; the source still owns authorization, Git limits and cleanup. */
  openSnapshot?: (
    repository: RepositorySkillRepository,
    branch: string,
    context: { directory: string; git: Git },
  ) => Promise<string>;
};

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FastAgentRepositorySourceError('text');
  }
}

function tree(bytes: Buffer): Entry[] {
  return decode(bytes)
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match =
        /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
          record,
        );
      if (!match || !validPath(match[4]!))
        throw new FastAgentRepositorySourceError('scope');
      return {
        mode: match[1]!,
        type: match[2]!,
        oid: match[3]!,
        path: match[4]!,
      };
    });
}

function regular(entry: Entry): boolean {
  return (
    entry.type === 'blob' &&
    (entry.mode === '100644' || entry.mode === '100755')
  );
}

export class FastAgentRepositorySource {
  private readonly allowed: Set<string>;
  private readonly options: FastAgentRepositorySourceOptions;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly roots = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  // Budget external tool calls, not the bounded Git steps within a search.
  private calls = 0;
  private deadline = 0;

  constructor(options: FastAgentRepositorySourceOptions) {
    this.options = options;
    this.allowed = new Set(options.allowedEnvironmentIds);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async checkResources(): Promise<void> {
    let bytes = 0;
    let entries = 0;
    const pending = [...this.roots];
    while (pending.length) {
      if (Date.now() >= this.deadline || ++entries > 8192)
        throw new FastAgentRepositorySourceError('budget');
      const path = pending.pop()!;
      const stat = await lstat(path);
      bytes += stat.size;
      if (bytes > MAX_DISK || stat.isSymbolicLink())
        throw new FastAgentRepositorySourceError('budget');
      if (stat.isDirectory()) {
        for (const name of await readdir(path)) pending.push(join(path, name));
      }
    }
  }

  private async cleanup(): Promise<void> {
    let failed = false;
    for (const root of this.roots) {
      try {
        await rm(root, { recursive: true, force: true });
        this.roots.delete(root);
      } catch {
        failed = true;
      }
    }
    this.snapshots.clear();
    if (failed) throw new FastAgentRepositorySourceError('cleanup');
  }

  private async open(
    repository: RepositorySkillRepository,
    branch: string,
  ): Promise<Snapshot> {
    const url = new URL(repository.cloneUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
      throw new FastAgentRepositorySourceError('transport');
    }
    url.username = '';
    url.password = '';
    const root = await mkdtemp(join(tmpdir(), 'roomote-fast-source-'));
    this.roots.add(root);
    const directory = join(root, 'repository.git');
    const credential = await resolveRepositorySkillCredential(repository);
    const authentication = await buildGitAuthenticationEnvironment(
      root,
      credential,
    );
    // The shared helper includes process.env. Never inherit its Git overrides.
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: root,
      XDG_CONFIG_HOME: root,
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'http:https',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
    if ('authorizationHeader' in credential) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = authentication.GIT_CONFIG_VALUE_0;
    } else {
      env.GIT_ASKPASS = authentication.GIT_ASKPASS;
      env.ROOMOTE_FAST_SKILL_GIT_TOKEN =
        authentication.ROOMOTE_FAST_SKILL_GIT_TOKEN;
      env.ROOMOTE_FAST_SKILL_GIT_USERNAME =
        authentication.ROOMOTE_FAST_SKILL_GIT_USERNAME;
    }
    const git: Git = async (args) => {
      await this.checkResources();
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) throw new FastAgentRepositorySourceError('budget');
      const output = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/prlimit',
          [
            '--fsize=16777216',
            '--as=536870912',
            '--cpu=30',
            '--',
            'git',
            `--git-dir=${directory}`,
            '-c',
            'credential.helper=',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'init.templateDir=',
            '-c',
            'http.followRedirects=false',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.http.allow=always',
            '-c',
            'protocol.https.allow=always',
            '-c',
            'gc.auto=0',
            '-c',
            'maintenance.auto=false',
            '-c',
            'fetch.unpackLimit=1',
            ...args,
          ],
          { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        const kill = () => {
          failed = true;
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(kill, Math.min(60_000, remaining));
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) kill();
          else if (!failed) chunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) kill();
        });
        child.on('error', () => {
          failed = true;
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failed || code !== 0)
            reject(new FastAgentRepositorySourceError('transport'));
          else resolve(Buffer.concat(chunks));
        });
      });
      await this.checkResources();
      return output;
    };
    let revision: string;
    if (this.options.openSnapshot) {
      revision = await this.options.openSnapshot(repository, branch, {
        directory,
        git,
      });
    } else {
      await git(['init', '--bare']);
      await git(['remote', 'add', 'origin', url.href]);
      await git(['config', 'remote.origin.promisor', 'true']);
      await git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
      await git([
        'fetch',
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        `refs/heads/${branch}`,
      ]);
      revision = decode(
        await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']),
      ).trim();
    }
    if (!SHA.test(revision))
      throw new FastAgentRepositorySourceError('transport');
    revision = revision.toLowerCase();
    if (
      decode(
        await git(['rev-parse', '--verify', `${revision}^{commit}`]),
      ).trim() !== revision
    ) {
      throw new FastAgentRepositorySourceError('transport');
    }
    await this.checkResources();
    return {
      revision,
      git,
      identity: JSON.stringify([
        repository.cloneUrl,
        repository.sourceControlProvider,
        repository.installationId,
        repository.githubRepoId,
      ]),
    };
  }

  private async text(snapshot: Snapshot, entry: Entry): Promise<string> {
    if (!regular(entry)) throw new FastAgentRepositorySourceError('scope');
    const size = Number(
      decode(await snapshot.git(['cat-file', '-s', entry.oid])).trim(),
    );
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB)
      throw new FastAgentRepositorySourceError('text');
    const bytes = await snapshot.git(['cat-file', 'blob', entry.oid]);
    if (bytes.length !== size || bytes.includes(0))
      throw new FastAgentRepositorySourceError('text');
    return decode(bytes);
  }

  async inspect(input: unknown) {
    return this.serialize(async () => {
      try {
        if (this.disposed) throw new FastAgentRepositorySourceError('disposed');
        if (++this.calls > 20)
          throw new FastAgentRepositorySourceError('budget');
        this.deadline = Date.now() + 60_000;
        const parsed = fastAgentRepositoryInspectSchema.safeParse(input);
        if (!parsed.success)
          throw new FastAgentRepositorySourceError('arguments');
        const args = parsed.data;
        const repositories: RepositorySkillRepository[] = await (
          this.options.resolveRepositories ?? resolveRepositorySkillRepositories
        )([...this.allowed]);
        const repository = repositories.find(
          (repo) =>
            repo.id === args.repositoryId &&
            repo.environmentIds.some((id) => this.allowed.has(id)),
        );
        if (!repository)
          throw new FastAgentRepositorySourceError('authorization');
        const branch = args.branch ?? repository.defaultBranch;
        if (!validBranch(branch))
          throw new FastAgentRepositorySourceError('arguments');
        const key = JSON.stringify([repository.id, branch]);
        let snapshot = this.snapshots.get(key);
        const identity = JSON.stringify([
          repository.cloneUrl,
          repository.sourceControlProvider,
          repository.installationId,
          repository.githubRepoId,
        ]);
        if (snapshot && snapshot.identity !== identity)
          throw new FastAgentRepositorySourceError('authorization');
        if (!snapshot) {
          if (this.snapshots.size >= 2)
            throw new FastAgentRepositorySourceError('budget');
          snapshot = await this.open(repository, branch);
          this.snapshots.set(key, snapshot);
        }
        if (args.revision && args.revision.toLowerCase() !== snapshot.revision)
          throw new FastAgentRepositorySourceError('revision');
        const base = {
          revision: snapshot.revision,
          repository: {
            id: repository.id,
            fullName: repository.fullName.slice(0, 200),
            branch,
          },
          scope: args.path,
          tested: false as const,
          mode: 'source-only' as const,
          guidance:
            'Source inspection only; no checkout, setup, hooks, commands from the repository, or tests were run.',
        };
        const members = args.path
          ? tree(
              await snapshot.git([
                'ls-tree',
                '-z',
                snapshot.revision,
                '--',
                args.path,
              ]),
            )
          : [];
        const member = members.find((entry) => entry.path === args.path);
        if (args.path && !member)
          throw new FastAgentRepositorySourceError('scope');
        let result: object;
        if (args.action === 'read') {
          const lines = (await this.text(snapshot, member!)).split('\n');
          if (lines.at(-1) === '') lines.pop();
          const selected: string[] = [];
          const truncatedLines: number[] = [];
          let index = args.startLine - 1;
          for (
            ;
            index < lines.length && selected.length < args.limit;
            index++
          ) {
            const raw = lines[index]!;
            const line = `${index + 1}: ${raw.slice(0, 2000)}${raw.length > 2000 ? ' [line truncated]' : ''}`;
            if (
              Buffer.byteLength(JSON.stringify([...selected, line])) >
              24 * 1024
            )
              break;
            selected.push(line);
            if (raw.length > 2000) truncatedLines.push(index + 1);
          }
          result = {
            ...base,
            content: selected.join('\n'),
            totalLines: lines.length,
            truncated: index < lines.length || truncatedLines.length > 0,
            truncatedLines,
            ...(index < lines.length ? { nextStartLine: index + 1 } : {}),
          };
        } else {
          if (member && member.type !== 'tree' && args.action === 'list')
            throw new FastAgentRepositorySourceError('scope');
          const entries =
            member && member.type !== 'tree'
              ? [member]
              : tree(
                  await snapshot.git([
                    'ls-tree',
                    '-z',
                    ...(args.action === 'search' ? ['-r'] : []),
                    args.path
                      ? `${snapshot.revision}:${args.path}`
                      : snapshot.revision,
                  ]),
                ).map((entry) => ({
                  ...entry,
                  path: args.path ? `${args.path}/${entry.path}` : entry.path,
                }));
          if (args.action === 'list') {
            const selected: Array<{
              path: string;
              mode: string;
              type: string;
            }> = [];
            for (const entry of entries.slice(0, args.limit)) {
              const next = {
                path: entry.path,
                mode: entry.mode,
                type: entry.type,
              };
              if (
                Buffer.byteLength(JSON.stringify([...selected, next])) >
                24 * 1024
              )
                break;
              selected.push(next);
            }
            result = {
              ...base,
              entries: selected,
              truncated: selected.length < entries.length,
              ...(selected.length < entries.length
                ? {
                    guidance:
                      'Listing truncated. Narrow the directory scope; pagination is not available.',
                  }
                : {}),
            };
          } else {
            const files = entries.filter(regular);
            if (files.length > 16)
              throw new FastAgentRepositorySourceError('scope');
            const matches: Array<{
              path: string;
              line: number;
              preview: string;
              previewTruncated: boolean;
            }> = [];
            let skippedFiles = entries.length - files.length;
            let scannedFiles = 0;
            let truncated = false;
            for (const file of files) {
              let content: string;
              try {
                content = await this.text(snapshot, file);
              } catch (error) {
                if (
                  !(error instanceof FastAgentRepositorySourceError) ||
                  error.code !== 'text'
                )
                  throw error;
                skippedFiles++;
                continue;
              }
              scannedFiles++;
              const lines = content.split('\n');
              for (let line = 0; line < lines.length; line++) {
                const raw = lines[line]!;
                const matchIndex = raw.indexOf(args.query!);
                if (matchIndex < 0) continue;
                const start = Math.max(0, matchIndex - 100);
                const match = {
                  path: file.path,
                  line: line + 1,
                  preview: raw.slice(start, start + 400),
                  previewTruncated: start > 0 || raw.length > start + 400,
                };
                if (
                  matches.length >= Math.min(args.limit, 50) ||
                  Buffer.byteLength(JSON.stringify([...matches, match])) >
                    24 * 1024
                ) {
                  truncated = true;
                  break;
                }
                matches.push(match);
              }
              if (truncated) break;
            }
            result = {
              ...base,
              matches,
              scannedFiles,
              skippedFiles,
              unscannedFiles: entries.length - scannedFiles - skippedFiles,
              incomplete: truncated || skippedFiles > 0,
              truncated,
            };
          }
        }
        if (
          Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT ||
          JSON.stringify(result, null, 2).split('\n').length > 1900
        )
          throw new FastAgentRepositorySourceError('budget');
        return result;
      } catch (error) {
        const safe =
          error instanceof FastAgentRepositorySourceError
            ? error
            : new FastAgentRepositorySourceError('transport');
        if (
          safe.code === 'transport' ||
          safe.code === 'budget' ||
          safe.code === 'authorization'
        ) {
          this.disposed = true;
          await this.cleanup();
        }
        throw safe;
      }
    });
  }

  async dispose(): Promise<void> {
    return this.serialize(async () => {
      this.disposed = true;
      await this.cleanup();
    });
  }
}
