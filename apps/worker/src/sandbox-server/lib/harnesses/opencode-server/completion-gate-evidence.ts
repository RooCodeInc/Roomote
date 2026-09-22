import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join, relative } from 'node:path';

import { TASK_COMPLETION_GATE_LIMITS } from '@roomote/types';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 20;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_FILE_BYTES = 200_000;
// Beyond these a file is fingerprinted by its raw bytes, not normalized text.
const MAX_FINGERPRINT_FILES = 300;
const MAX_FINGERPRINT_FILE_BYTES = 2_000_000;
const CLIPPED_PATCH_MARKER = '\n[... rest of this patch clipped ...]\n';

/** Generated files whose patches say nothing about whether the work is done. */
const NOISE_FILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'go.sum',
];
const NOISE_FILE_SUFFIXES = ['.snap', '.min.js'];
const NOISE_PATHSPECS = [
  ...NOISE_FILE_NAMES.map((name) => `:(exclude,glob)**/${name}`),
  ...NOISE_FILE_SUFFIXES.map((suffix) => `:(exclude,glob)**/*${suffix}`),
];

/** The same exclusion for untracked files, which no pathspec filters. */
function isNoiseFile(file: string): boolean {
  const name = basename(file);

  return (
    NOISE_FILE_NAMES.includes(name) ||
    NOISE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

type GitRunner = (
  repoPath: string,
  args: string[],
  options?: { allowExitCodes?: number[] },
) => Promise<string | null>;

/** Resolves to stdout, or `null` when git fails or times out. */
const runGit: GitRunner = (repoPath, args, options) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        const exitCode =
          error && typeof error.code === 'number' ? error.code : null;

        if (
          error &&
          !(exitCode !== null && options?.allowExitCodes?.includes(exitCode))
        ) {
          resolve(null);
          return;
        }

        resolve(stdout);
      },
    );
  });

/** The workspace itself, or the checkouts up to two levels under a shared root. */
function discoverWorkspaceRepositories(workspacePath: string): string[] {
  if (existsSync(join(workspacePath, '.git'))) {
    return [workspacePath];
  }

  const repositories: string[] = [];
  const childDirectories = (directory: string): string[] => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            entry.name !== 'node_modules',
        )
        .map((entry) => join(directory, entry.name));
    } catch {
      return [];
    }
  };

  for (const child of childDirectories(workspacePath)) {
    const candidates = existsSync(join(child, '.git'))
      ? [child]
      : childDirectories(child).filter((grandchild) =>
          existsSync(join(grandchild, '.git')),
        );

    for (const candidate of candidates) {
      if (repositories.length >= MAX_REPOSITORIES) {
        return repositories;
      }

      repositories.push(candidate);
    }
  }

  return repositories;
}

/**
 * Where this task's work on the current branch began. A fresh branch starts
 * at its fork point from the default branch. A branch that already carried
 * work when the task checked it out (an existing pull request) starts at that
 * checkout, read from the reflog, so earlier work on the pull request is not
 * judged as this task's and a requested removal of it still shows as a change.
 */
async function resolveTaskBase(
  repoPath: string,
  git: GitRunner,
): Promise<string | null> {
  const head = (
    await git(repoPath, ['rev-parse', '--verify', '-q', 'HEAD'])
  )?.trim();

  if (!head) {
    return null;
  }

  const forkPoint =
    (await git(repoPath, ['merge-base', 'HEAD', 'origin/HEAD']))?.trim() ||
    null;
  const branch = (
    await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  )?.trim();
  let branchStart: string | null = null;

  if (branch && branch !== 'HEAD') {
    const reflog = await git(repoPath, [
      'reflog',
      'show',
      'HEAD',
      '--format=%H%x09%gs',
    ]);
    const suffix = ` to ${branch}`;

    // Newest first, so the last match is the first checkout of this branch.
    for (const line of reflog?.split('\n') ?? []) {
      const [hash, subject] = line.split('\t');

      if (
        hash &&
        subject?.startsWith('checkout: moving from ') &&
        subject.endsWith(suffix)
      ) {
        branchStart = hash;
      }
    }

    if (
      branchStart &&
      (await git(repoPath, [
        'merge-base',
        '--is-ancestor',
        branchStart,
        'HEAD',
      ])) === null
    ) {
      // History was rewritten since the checkout (rebase, reset).
      branchStart = null;
    }
  }

  if (
    branchStart &&
    forkPoint &&
    (await git(repoPath, [
      'merge-base',
      '--is-ancestor',
      forkPoint,
      branchStart,
    ])) === null
  ) {
    // The default branch was merged in after the checkout; its changes are
    // not this task's, and only the fork point leaves them out.
    return forkPoint;
  }

  return branchStart ?? forkPoint ?? head;
}

function isLikelyText(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    return stats.isFile() && stats.size <= MAX_UNTRACKED_FILE_BYTES;
  } catch {
    return false;
  }
}

async function collectRepositoryDiff(
  repoPath: string,
  git: GitRunner,
): Promise<{ diff: string; diffStat: string; fingerprint: string } | null> {
  const base = await resolveTaskBase(repoPath, git);

  if (!base) {
    return null;
  }

  const [tracked, stat, untrackedList, changedList] = await Promise.all([
    git(repoPath, ['diff', '--no-color', base, '--', '.', ...NOISE_PATHSPECS]),
    git(repoPath, ['diff', '--no-color', '--stat=120', base]),
    git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(repoPath, [
      'diff',
      '--name-only',
      '-z',
      base,
      '--',
      '.',
      ...NOISE_PATHSPECS,
    ]),
  ]);

  if (tracked === null) {
    return null;
  }

  const untrackedAll = (untrackedList ?? '')
    .split('\0')
    .filter((file) => file && !isNoiseFile(file));
  // The patch shown to the model leaves out large and binary files; the
  // fingerprint below still covers them.
  const untracked = untrackedAll
    .filter((file) => isLikelyText(join(repoPath, file)))
    .slice(0, MAX_UNTRACKED_FILES);
  const untrackedPatches = await Promise.all(
    untracked.map((file) =>
      // `--no-index` exits 1 whenever the files differ, which is always here.
      git(
        repoPath,
        ['diff', '--no-color', '--no-index', '--', '/dev/null', file],
        { allowExitCodes: [1] },
      ),
    ),
  );

  return {
    fingerprint: await fingerprintChangedFiles(repoPath, [
      ...(changedList ?? '').split('\0').filter(Boolean),
      ...untrackedAll,
    ]),
    diff: [tracked, ...untrackedPatches.filter(Boolean)].join(''),
    diffStat: [
      (stat ?? '').trimEnd(),
      ...untracked.map((file) => ` ${file} (new file)`),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Fit a diff into `maxChars` by clipping the largest patches first, so every
 * changed file keeps at least the head of its patch.
 */
export function clipDiffByFile(
  diff: string,
  maxChars: number,
): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) {
    return { diff, truncated: false };
  }

  const patches = diff.split(/^(?=diff --git )/m);
  const order = patches
    .map((patch, index) => ({ index, length: patch.length }))
    .sort((a, b) => a.length - b.length);
  const budgets = new Array<number>(patches.length).fill(0);
  let remaining = maxChars;

  order.forEach(({ index, length }, position) => {
    const share = Math.floor(remaining / (order.length - position));
    budgets[index] = Math.min(length, share);
    remaining -= budgets[index]!;
  });

  return {
    truncated: true,
    diff: patches
      .map((patch, index) => {
        const budget = budgets[index]!;

        if (patch.length <= budget) {
          return patch;
        }

        const keep = Math.max(0, budget - CLIPPED_PATCH_MARKER.length);
        return `${patch.slice(0, keep)}${CLIPPED_PATCH_MARKER}`;
      })
      .join('')
      .slice(0, maxChars),
  };
}

/**
 * What formatters and pre-commit hooks rewrite without changing behavior:
 * whitespace, quote style, trailing commas, and semicolons. Parentheses stay
 * in: a formatter adds them too (around an arrow parameter, a wrapped
 * return), but they can also change precedence, and missing a real edit is
 * the worse mistake. When a reformat does move parentheses after a test run,
 * that run reads as stale and the agent is asked to run it again.
 */
const FORMATTING_ONLY_CHARACTERS = /[\s'"`;,]/g;

/**
 * Files no test, type check, lint, or build reads: prose and release notes.
 * Delivery writes a changeset and PR notes after the last test run, and
 * counting those as code made every earlier run read as stale.
 */
const PROSE_FILE_PATTERN =
  /(^|\/)(\.changeset\/|CHANGELOG)|\.(md|mdx|txt|rst)$/i;

/**
 * The code this task has changed, reduced to what a formatter cannot alter:
 * every changed file's current content with formatting-only characters
 * removed. It is read from the files rather than the patch text, because a
 * reformat moves hunks and line counts even where no code changed. Two
 * moments with the same fingerprint hold the same code, however it got there:
 * an editor tool, `sed -i`, a heredoc script, or a git operation.
 */
async function fingerprintChangedFiles(
  repoPath: string,
  files: string[],
): Promise<string> {
  const hash = createHash('sha256');
  const paths = [...new Set(files)]
    .filter((file) => !PROSE_FILE_PATTERN.test(file))
    .sort();

  for (const [index, file] of paths.entries()) {
    const filePath = join(repoPath, file);
    // Every changed file is read, so an edit anywhere changes the result.
    // Past the caps the bytes are streamed into a hash as they are:
    // normalizing is the expensive part, large files are never held in
    // memory, and skipping it only errs toward calling a run stale.
    const content = await stat(filePath).then(
      async (stats) => {
        if (
          index < MAX_FINGERPRINT_FILES &&
          stats.size <= MAX_FINGERPRINT_FILE_BYTES
        ) {
          return (await readFile(filePath, 'utf8')).replace(
            FORMATTING_ONLY_CHARACTERS,
            '',
          );
        }

        const bytes = createHash('sha256');
        await pipeline(createReadStream(filePath), bytes);
        return bytes.digest('hex');
      },
      () => 'deleted',
    );
    hash.update(`${file}\0${content}\0`);
  }

  return hash.digest('hex');
}

interface ShippedDiff {
  /** Hash of the unclipped diff: the identity of the work being checked. */
  key: string;
  /** Format-insensitive identity of the changed code; see above. */
  fingerprint: string;
  diff: string;
  diffStat: string;
  diffTruncated: boolean;
}

/** The fingerprint of a workspace this task has not changed. */
export const UNCHANGED_WORKSPACE_FINGERPRINT = 'unchanged';

/** What this task changed across the workspace, or `null` when nothing did. */
export async function collectShippedDiff(
  workspacePath: string,
  git: GitRunner = runGit,
): Promise<ShippedDiff | null> {
  const repositories = discoverWorkspaceRepositories(workspacePath);
  const sections = (
    await Promise.all(
      repositories.map(async (repoPath) => {
        const result = await collectRepositoryDiff(repoPath, git);

        if (!result?.diff.trim()) {
          return null;
        }

        const label = relative(workspacePath, repoPath);

        return repositories.length > 1 && label
          ? {
              fingerprint: `${label}:${result.fingerprint}`,
              diff: `# repository: ${label}\n${result.diff}`,
              diffStat: `# repository: ${label}\n${result.diffStat}`,
            }
          : result;
      }),
    )
  ).filter((section) => section !== null);

  if (sections.length === 0) {
    return null;
  }

  const fullDiff = sections.map((section) => section.diff).join('\n');
  const clipped = clipDiffByFile(
    fullDiff,
    TASK_COMPLETION_GATE_LIMITS.diffMaxChars,
  );

  return {
    key: createHash('sha256').update(fullDiff).digest('hex'),
    fingerprint: createHash('sha256')
      .update(sections.map((section) => section.fingerprint).join('\n'))
      .digest('hex'),
    diff: clipped.diff,
    diffTruncated: clipped.truncated,
    diffStat: sections
      .map((section) => section.diffStat)
      .join('\n')
      .slice(0, TASK_COMPLETION_GATE_LIMITS.diffStatMaxChars),
  };
}
