import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { watch } from 'chokidar';
import ignore, { type Ignore } from 'ignore';
import { observable } from '@trpc/server/observable';

import type { GitDiffResponse, GitDiffSummary, RepoDiff } from '../types';
import type { GitRepo } from '../lib/command-executor';
import { CommandExecutor } from '../lib/command-executor';
import { publicProcedure } from '../trpc';

import { parseUnifiedDiff } from './parse-diff';

const FILE_CHANGE_DEBOUNCE_MS = 300;

const WATCHER_STATS_WINDOW_MS = 60_000;

const HIGH_EVENT_VOLUME_THRESHOLD = 400;

const MAX_SAMPLE_PATHS = 10;

const DEFAULT_IGNORED_DIR_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
]);

const DEFAULT_IGNORED_BASENAMES = new Set(['.DS_Store']);

const GIT_STATE_WATCH_PATHS = [
  '.git/HEAD',
  '.git/index',
  '.git/refs/heads',
  '.git/packed-refs',
] as const;

export interface DiffRepoTarget {
  repoName: string;
  repoPath: string;
}

interface RepoIgnoreMatcher {
  repoName: string;
  repoPrefix: string;
  matcher: Ignore;
  patternCount: number;
}

interface RepoIgnoreLookup {
  rootMatcher: RepoIgnoreMatcher | null;
  byTopLevel: Map<string, RepoIgnoreMatcher[]>;
}

type DiffOutputLogger = Pick<Console, 'log' | 'info' | 'warn' | 'error'>;

type WatchEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

interface WatcherStats {
  windowStartMs: number;
  totalEvents: number;
  eventCounts: Record<WatchEventKind, number>;
  sampledPaths: string[];
}

/**
 * Subscribe to git diff output representing current committable changes in
 * the workspace (working tree + index vs HEAD).
 * Emits once immediately, then re-emits whenever workspace files change.
 */
export const diffOutput = publicProcedure.subscription(({ ctx }) => {
  return observable<GitDiffResponse>((emit) => {
    const { workingDirectory } = ctx;
    const logger: DiffOutputLogger = ctx.harnessLogger ?? console;
    let closed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshQueued = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let repos: DiffRepoTarget[] = [];
    let repoIgnoreMatchers: RepoIgnoreMatcher[] = [];
    let repoIgnoreLookup: RepoIgnoreLookup = {
      rootMatcher: null,
      byTopLevel: new Map(),
    };
    let shouldMarkUntrackedOnRefresh = true;
    let stats = createWatcherStats(Date.now());

    const flushWatcherStats = (force = false) => {
      const now = Date.now();
      const elapsed = now - stats.windowStartMs;

      if (!force && elapsed < WATCHER_STATS_WINDOW_MS) {
        return;
      }

      if (stats.totalEvents >= HIGH_EVENT_VOLUME_THRESHOLD) {
        logger.warn(
          `[diffOutput] High watcher event volume: ${stats.totalEvents} events in ${Math.round(elapsed / 1000)}s (add=${stats.eventCounts.add}, change=${stats.eventCounts.change}, unlink=${stats.eventCounts.unlink}, addDir=${stats.eventCounts.addDir}, unlinkDir=${stats.eventCounts.unlinkDir}). Sample paths: ${formatArrayPreview(stats.sampledPaths, MAX_SAMPLE_PATHS)}`,
        );
      }

      stats = createWatcherStats(now);
    };

    const recordWatcherEvent = (
      event: WatchEventKind,
      relativePath: string,
    ) => {
      stats.totalEvents += 1;
      stats.eventCounts[event] += 1;

      if (
        relativePath &&
        stats.sampledPaths.length < MAX_SAMPLE_PATHS &&
        !stats.sampledPaths.includes(relativePath)
      ) {
        stats.sampledPaths.push(relativePath);
      }

      flushWatcherStats();
    };

    const runRefresh = () => {
      if (closed) {
        return;
      }

      if (refreshing) {
        refreshQueued = true;
        return;
      }

      refreshing = true;
      const markUntrackedThisRun = shouldMarkUntrackedOnRefresh;
      shouldMarkUntrackedOnRefresh = false;

      void (async () => {
        if (markUntrackedThisRun) {
          await markUntrackedFiles({ repos, logger });
        }

        const next = await computeDiffSummary({ repos, logger });

        if (!closed) {
          emit.next(next);
        }
      })()
        .catch((error: unknown) => {
          if (closed) {
            return;
          }

          if (markUntrackedThisRun) {
            shouldMarkUntrackedOnRefresh = true;
          }

          emit.error(
            error instanceof Error
              ? error
              : new Error(`diffOutput failed: ${String(error)}`),
          );
        })
        .finally(() => {
          refreshing = false;

          if (refreshQueued && !closed) {
            refreshQueued = false;
            runRefresh();
          }
        });
    };

    const scheduleRefresh = ({ markUntracked }: { markUntracked: boolean }) => {
      if (markUntracked) {
        shouldMarkUntrackedOnRefresh = true;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        runRefresh();
      }, FILE_CHANGE_DEBOUNCE_MS);
    };

    void (async () => {
      repos = await resolveDiffRepos(workingDirectory);
      repoIgnoreMatchers = await loadRepoIgnoreMatchers(repos);
      repoIgnoreLookup = createRepoIgnoreLookup(repoIgnoreMatchers);

      // Emit the initial summary immediately.
      runRefresh();

      if (repos.length === 0) {
        return;
      }

      const watchTargets = buildRepoWatchTargets(workingDirectory, repos);

      const totalGitignorePatterns = repoIgnoreMatchers.reduce(
        (sum, matcher) => sum + matcher.patternCount,
        0,
      );

      logger.info(
        `[diffOutput] Starting watcher for ${repos.length} repo(s). Targets: ${formatArrayPreview(watchTargets)}. Ignore strategy: ${DEFAULT_IGNORED_DIR_SEGMENTS.size} default dir markers + ${DEFAULT_IGNORED_BASENAMES.size} default basenames + ${totalGitignorePatterns} patterns from ${repoIgnoreMatchers.length} repo .gitignore file(s).`,
      );

      watcher = watch(watchTargets, {
        cwd: workingDirectory,
        ignored: (watchPath) => {
          const relativePath = normalizeRelativePath(
            watchPath,
            workingDirectory,
          );

          if (!relativePath) {
            return false;
          }

          if (
            isGitStateWatchPathOrAncestor(relativePath, repos, workingDirectory)
          ) {
            return false;
          }

          if (isDefaultIgnoredPath(relativePath)) {
            return true;
          }

          return isIgnoredByRepoGitIgnore(relativePath, repoIgnoreLookup);
        },
        ignoreInitial: true,
        persistent: true,
        usePolling: false,
      });

      watcher.on('add', (path) => {
        recordWatcherEvent('add', path);
        scheduleRefresh({
          markUntracked: !isGitStateWatchPath(path, repos, workingDirectory),
        });
      });

      watcher.on('change', (path) => {
        recordWatcherEvent('change', path);
        scheduleRefresh({ markUntracked: false });
      });

      watcher.on('unlink', (path) => {
        recordWatcherEvent('unlink', path);
        scheduleRefresh({
          markUntracked: !isGitStateWatchPath(path, repos, workingDirectory),
        });
      });

      watcher.on('addDir', (path) => {
        recordWatcherEvent('addDir', path);
      });

      watcher.on('unlinkDir', (path) => {
        recordWatcherEvent('unlinkDir', path);
      });

      watcher.on('error', (error) => {
        if (!closed) {
          logger.warn(
            '[diffOutput] chokidar watcher error:',
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    })().catch((error: unknown) => {
      if (closed) {
        return;
      }

      emit.error(
        error instanceof Error
          ? error
          : new Error(`diffOutput setup failed: ${String(error)}`),
      );
    });

    return () => {
      closed = true;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      flushWatcherStats(true);
      void watcher?.close();
    };
  });
});

function createWatcherStats(nowMs: number): WatcherStats {
  return {
    windowStartMs: nowMs,
    totalEvents: 0,
    eventCounts: {
      add: 0,
      change: 0,
      unlink: 0,
      addDir: 0,
      unlinkDir: 0,
    },
    sampledPaths: [],
  };
}

function formatArrayPreview(values: string[], max = 5): string {
  if (values.length <= max) {
    return values.join(', ');
  }

  const shown = values.slice(0, max).join(', ');
  return `${shown}, ... (+${values.length - max} more)`;
}

function toRepoPrefix(repoName: string): string {
  return repoName === '.'
    ? ''
    : `${repoName.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
}

function normalizeRelativePath(
  inputPath: string,
  workingDirectory: string,
): string {
  const normalizedPath = inputPath.replace(/\\/g, '/');
  const normalizedRoot = workingDirectory
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');

  if (normalizedPath === '.' || normalizedPath === './') {
    return '';
  }

  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  if (normalizedPath === normalizedRoot) {
    return '';
  }

  return normalizedPath.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function isDefaultIgnoredPath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  const segments = relativePath.split('/').filter(Boolean);

  if (segments.some((segment) => DEFAULT_IGNORED_DIR_SEGMENTS.has(segment))) {
    return true;
  }

  const lastSegment = segments[segments.length - 1];
  return lastSegment ? DEFAULT_IGNORED_BASENAMES.has(lastSegment) : false;
}

export function isGitStateWatchPath(
  relativePath: string,
  repos: DiffRepoTarget[],
  workingDirectory: string,
): boolean {
  const normalizedRelativePath = normalizeRelativePath(
    relativePath,
    workingDirectory,
  );

  return repos.some((repo) => {
    const repoTarget = toRepoWatchTarget(workingDirectory, repo.repoPath);

    return GIT_STATE_WATCH_PATHS.some((gitStatePath) => {
      const targetPath =
        repoTarget === '.'
          ? gitStatePath
          : path.posix.join(repoTarget, gitStatePath);

      return (
        normalizedRelativePath === targetPath ||
        normalizedRelativePath.startsWith(`${targetPath}/`)
      );
    });
  });
}

export function isGitStateWatchPathOrAncestor(
  relativePath: string,
  repos: DiffRepoTarget[],
  workingDirectory: string,
): boolean {
  const normalizedRelativePath = normalizeRelativePath(
    relativePath,
    workingDirectory,
  );

  return getGitStateWatchTargets(workingDirectory, repos).some(
    (targetPath) =>
      normalizedRelativePath === targetPath ||
      targetPath.startsWith(`${normalizedRelativePath}/`),
  );
}

async function loadRepoIgnoreMatchers(
  repos: DiffRepoTarget[],
): Promise<RepoIgnoreMatcher[]> {
  const matchers: RepoIgnoreMatcher[] = [];

  for (const repo of repos) {
    const matcher = ignore();
    let patternCount = 0;

    try {
      const raw = await readFile(
        path.join(repo.repoPath, '.gitignore'),
        'utf8',
      );

      const lines = raw.split('\n');

      patternCount = lines.reduce((count, line) => {
        const trimmed = line.trim();

        return trimmed.length > 0 && !trimmed.startsWith('#')
          ? count + 1
          : count;
      }, 0);

      matcher.add(raw);
    } catch {
      // No .gitignore for this repo (or unreadable) - treat as empty rules.
    }

    matchers.push({
      repoName: repo.repoName,
      repoPrefix: toRepoPrefix(repo.repoName),
      matcher,
      patternCount,
    });
  }

  return matchers;
}

function isIgnoredByRepoGitIgnore(
  relativePath: string,
  lookup: RepoIgnoreLookup,
): boolean {
  const matcher = resolveIgnoreMatcherForPath(relativePath, lookup);

  if (!matcher) {
    return false;
  }

  const repoRelativePath = matcher.repoPrefix
    ? relativePath.slice(matcher.repoPrefix.length)
    : relativePath;

  return repoRelativePath ? matcher.matcher.ignores(repoRelativePath) : false;
}

async function markUntrackedFiles({
  repos,
  logger,
}: {
  repos: DiffRepoTarget[];
  logger: DiffOutputLogger;
}): Promise<void> {
  for (const repo of repos) {
    try {
      await CommandExecutor.gitAddIntentToAdd({
        cwd: repo.repoPath,
        timeout: 10_000,
      });
    } catch (error) {
      // Log and continue — a git index.lock conflict is not fatal.
      logger.warn(
        `[diffOutput] git add --intent-to-add failed for "${repo.repoName}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function isMissingHeadError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes("ambiguous argument 'HEAD'") ||
    message.includes('unknown revision or path not in the working tree') ||
    message.includes('bad revision')
  );
}

async function computeDiffSummary({
  repos,
  logger,
}: {
  repos: DiffRepoTarget[];
  logger: DiffOutputLogger;
}): Promise<GitDiffResponse> {
  if (repos.length === 0) {
    return {
      repos: [],
      summary: createDiffSummary([]),
    };
  }

  const summaries: RepoDiff[] = [];

  for (const repo of repos) {
    const { repoName, repoPath } = repo;

    try {
      let result = await CommandExecutor.gitDiff({
        cwd: repoPath,
        baseSha: 'HEAD',
        timeout: 30_000,
      });

      // Repos without a first commit do not have HEAD.
      // Fall back to plain `git diff` so we can still show worktree changes.
      if (
        !result.success &&
        isMissingHeadError(result.stderr || result.error)
      ) {
        result = await CommandExecutor.gitDiff({
          cwd: repoPath,
          timeout: 30_000,
        });
      }

      if (!result.success) {
        logger.warn(
          `[diffOutput] git diff failed for repo "${repoName}": ${result.stderr || result.error}`,
        );

        continue;
      }

      const files = parseUnifiedDiff(result.stdout);

      const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

      summaries.push({
        repoName,
        files,
        totalAdditions,
        totalDeletions,
      });
    } catch (error) {
      logger.warn(
        `[diffOutput] Failed to compute diff for repo "${repoName}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    repos: summaries,
    summary: createDiffSummary(summaries),
  };
}

function toRepoWatchTarget(workingDirectory: string, repoPath: string): string {
  if (repoPath === workingDirectory) {
    return '.';
  }

  const prefix = `${workingDirectory}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : '.';
}

export function buildRepoWatchTargets(
  workingDirectory: string,
  repos: DiffRepoTarget[],
): string[] {
  const targets = new Set<string>();

  for (const repo of repos) {
    const repoTarget = toRepoWatchTarget(workingDirectory, repo.repoPath);

    targets.add(repoTarget);
  }

  for (const targetPath of getGitStateWatchTargets(workingDirectory, repos)) {
    targets.add(targetPath);
  }

  return [...targets];
}

function getGitStateWatchTargets(
  workingDirectory: string,
  repos: DiffRepoTarget[],
): string[] {
  return repos.flatMap((repo) => {
    const repoTarget = toRepoWatchTarget(workingDirectory, repo.repoPath);

    return GIT_STATE_WATCH_PATHS.map((gitStatePath) =>
      repoTarget === '.'
        ? gitStatePath
        : path.posix.join(repoTarget, gitStatePath),
    );
  });
}

async function resolveDiffRepos(
  workingDirectory: string,
): Promise<DiffRepoTarget[]> {
  const discovered: GitRepo[] = await CommandExecutor.gitFindRepos({
    cwd: workingDirectory,
    timeout: 30_000,
  });

  return discovered.map((repo) => ({
    repoName: repo.name,
    repoPath: repo.path,
  }));
}

function createRepoIgnoreLookup(
  matchers: RepoIgnoreMatcher[],
): RepoIgnoreLookup {
  const byTopLevel = new Map<string, RepoIgnoreMatcher[]>();
  let rootMatcher: RepoIgnoreMatcher | null = null;

  for (const matcher of matchers) {
    if (!matcher.repoPrefix) {
      rootMatcher = matcher;
      continue;
    }

    const repoPathWithoutTrailingSlash = matcher.repoPrefix.replace(/\/$/, '');
    const [topLevel] = repoPathWithoutTrailingSlash.split('/');

    if (!topLevel) {
      continue;
    }

    const existing = byTopLevel.get(topLevel);
    if (existing) {
      existing.push(matcher);
    } else {
      byTopLevel.set(topLevel, [matcher]);
    }
  }

  for (const candidates of byTopLevel.values()) {
    candidates.sort((a, b) => b.repoPrefix.length - a.repoPrefix.length);
  }

  return { rootMatcher, byTopLevel };
}

function resolveIgnoreMatcherForPath(
  relativePath: string,
  lookup: RepoIgnoreLookup,
): RepoIgnoreMatcher | null {
  const [topLevel] = relativePath.split('/', 1);

  if (topLevel) {
    const candidates = lookup.byTopLevel.get(topLevel);

    if (candidates) {
      for (const candidate of candidates) {
        if (relativePath.startsWith(candidate.repoPrefix)) {
          return candidate;
        }
      }
    }
  }

  return lookup.rootMatcher;
}

function createDiffSummary(repos: RepoDiff[]): GitDiffSummary {
  const changedFileCount = repos.reduce(
    (sum, repo) => sum + repo.files.length,
    0,
  );
  const totalAdditions = repos.reduce(
    (sum, repo) => sum + repo.totalAdditions,
    0,
  );
  const totalDeletions = repos.reduce(
    (sum, repo) => sum + repo.totalDeletions,
    0,
  );

  return {
    repoCount: repos.length,
    changedFileCount,
    totalAdditions,
    totalDeletions,
    hasPendingChanges: changedFileCount > 0,
  };
}
