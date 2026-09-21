import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import {
  TASK_COMPLETION_GATE_ENV_VAR,
  TASK_COMPLETION_GATE_LIMITS,
  TaskPayloadKind,
  taskCompletionCheckResponseSchema,
  type TaskCompletionCheckRequest,
  type TaskCompletionCheckResponse,
  type TaskCompletionFlagId,
} from '@roomote/types';

import {
  buildApiHeaders,
  fetchWithTimeout,
} from '../../../../mcp/roomote-mcp-server/api-client';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * The turn is held open while the API answers. The ceiling sits above the
 * server's own decision-model timeout so the server's `skipped` wins the race.
 */
const COMPLETION_CHECK_TIMEOUT_MS = 8_000;
const MAX_REPOSITORIES = 20;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_FILE_BYTES = 200_000;
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

/**
 * The platform turns the check on per run. PR reviews are themselves the
 * review pass, and automations report through their own result contract
 * rather than a person's request.
 */
export function isCompletionGateEligible(
  env: Record<string, string> | undefined,
): boolean {
  const taskType = env?.ROOMOTE_TASK_TYPE?.trim();

  return Boolean(
    env?.[TASK_COMPLETION_GATE_ENV_VAR] === 'true' &&
    env.ROOMOTE_CLOUD_TOKEN &&
    env.ROOMOTE_PLATFORM_API_URL &&
    env.ROOMOTE_TASK_RUN_ID &&
    env.ROOMOTE_AUTOMATION_TASK !== 'true' &&
    taskType !== TaskPayloadKind.GithubPrReview &&
    taskType !== TaskPayloadKind.GithubPrReviewSync,
  );
}

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
): Promise<{ diff: string; diffStat: string } | null> {
  const base = await resolveTaskBase(repoPath, git);

  if (!base) {
    return null;
  }

  const [tracked, stat, untrackedList] = await Promise.all([
    git(repoPath, ['diff', '--no-color', base, '--', '.', ...NOISE_PATHSPECS]),
    git(repoPath, ['diff', '--no-color', '--stat=120', base]),
    git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  if (tracked === null) {
    return null;
  }

  const untracked = (untrackedList ?? '')
    .split('\0')
    .filter(
      (file) =>
        file && !isNoiseFile(file) && isLikelyText(join(repoPath, file)),
    )
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

interface ShippedDiff {
  /** Hash of the unclipped diff: the identity of the work being checked. */
  key: string;
  diff: string;
  diffStat: string;
  diffTruncated: boolean;
}

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
    diff: clipped.diff,
    diffTruncated: clipped.truncated,
    diffStat: sections
      .map((section) => section.diffStat)
      .join('\n')
      .slice(0, TASK_COMPLETION_GATE_LIMITS.diffStatMaxChars),
  };
}

const SHELL_SOURCE_MUTATION_PATTERNS = [
  // In-place editors.
  /\b(sed|gsed)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i/,
  /\bperl\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i/,
  // Git operations that rewrite tracked content.
  /\bgit\s+(checkout|restore|apply|am|merge|rebase|cherry-pick|revert|reset|pull)\b/,
  /\bgit\s+stash\s+(pop|apply)\b/,
  /\bpatch\s+(-|<)/,
  // Output written to a file outside scratch space. `2>&1`, `>/dev/null`,
  // and `> /tmp/...` are not edits, and the target has to look like a path
  // so a comparison inside a quoted script (`1 > 0`) is not mistaken for one.
  /(^|[^0-9&>])>>?\s*(?!&|\s|\/dev\/|\/tmp\/|\/private\/tmp\/|\$\{?TMPDIR)(?=[^\s&|;]*[./][a-zA-Z])[^\s&|;]/,
  /\btee\s+(-a\s+)?(?!\/dev\/|\/tmp\/|\/private\/tmp\/)[^\s-]/,
];

/**
 * Whether a shell command plainly rewrites source, which makes any earlier
 * validation run stale the same way an editor tool does. Deliberately narrow:
 * formatters, hooks, and installs also touch files, and treating those as
 * edits would flag every honest "tests pass" that was followed by a format.
 */
export function isLikelySourceMutatingCommand(command: string): boolean {
  return SHELL_SOURCE_MUTATION_PATTERNS.some((pattern) =>
    pattern.test(command),
  );
}

/** Never throws: a check that cannot be made is a check that was skipped. */
export async function requestTaskCompletionCheck(
  env: Record<string, string>,
  check: TaskCompletionCheckRequest,
): Promise<TaskCompletionCheckResponse> {
  const skipped: TaskCompletionCheckResponse = { status: 'skipped', flags: [] };

  try {
    const response = await fetchWithTimeout(
      `${env.ROOMOTE_PLATFORM_API_URL!.replace(/\/+$/, '')}/api/mcp/tasks/runs/${env.ROOMOTE_TASK_RUN_ID}/completion_check`,
      {
        method: 'POST',
        headers: buildApiHeaders(
          {
            token: env.ROOMOTE_CLOUD_TOKEN!,
            authBypassHeaderName: env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
            authBypassHeaderValue: env.ROOMOTE_AUTH_BYPASS_VALUE,
          },
          { 'Content-Type': 'application/json' },
        ),
        body: JSON.stringify(check),
      },
      {
        label: 'Task completion check',
        timeoutMs: COMPLETION_CHECK_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      return skipped;
    }

    const parsed = taskCompletionCheckResponseSchema.safeParse(
      await response.json(),
    );

    return parsed.success ? parsed.data : skipped;
  } catch {
    return skipped;
  }
}

const FLAG_GUIDANCE: Record<TaskCompletionFlagId, string> = {
  requestUnaddressed:
    'Part of what was asked does not appear to be done, and your report does not say why.',
  planIncomplete:
    'Your checklist still has an item that is not completed, and your report does not account for it.',
  validationContradicted:
    'Your report claims a validation result that the commands you actually ran do not support: the last run failed, or no such command was run.',
  validationMissing:
    'Code changed but no test, type check, lint, or build was run, and your report does not say why.',
  proofClaimDoubtful:
    'The diff changes something a person sees in the interface, but your report waves off visual proof or never mentions it.',
  evidentDefect:
    'The changed lines appear to contain a plain defect: an inverted condition, a removed guard, error check, or await, a call left on an old signature, or a test weakened so it passes.',
  reportOverclaims:
    'Your report describes a code change that the diff does not contain.',
  leftoverArtifacts:
    'The diff appears to add something that should not ship: debug logging, commented-out code, a placeholder standing in for requested behavior, or a disabled test.',
};

/** The hidden prompt that reopens a turn the completion check flagged. */
export function buildCompletionGateReminder(
  flags: TaskCompletionCheckResponse['flags'],
): string {
  return [
    'Roomote automatically compared what was asked, your closing report, and everything this task changed, and flagged the following:',
    '',
    ...flags.map((flag) => `- ${FLAG_GUIDANCE[flag.id]}`),
    '',
    'This check is a quick automated read and can be wrong. Re-read the request and your diff against each point. If a point is right, make the smallest fix, re-run the validation it affects, deliver the update the same way you delivered the change, and send a short corrected report. If a point is wrong, change nothing and say in one sentence why the work is complete as it stands. Do not restart the task, do not repeat work that is already done, and do not mention this check to the user.',
  ].join('\n');
}
