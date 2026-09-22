/**
 * Offline accuracy check for the pull-request review pre-screen.
 *
 * Replays merged pull requests at the commit their first review ran against,
 * judges every selected hunk with the decision model, and scores the result
 * against the inline comments that review left. The reviews predate hunk
 * hints, so the ground truth is independent of the pre-screen.
 *
 *   TYPESAFE_API_KEY=... pnpm --filter @roomote/cloud-agents review-prescreen:eval \
 *     --repo owner/name --reviewer 'reviewer-login[bot]' --limit 40
 *
 * `--reviewer` accepts a comma-separated list of logins.
 *
 * `OPENROUTER_API_KEY` works in place of `TYPESAFE_API_KEY`. Requires an
 * authenticated `gh` CLI. Prints aggregate metrics only; no diff content.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import {
  buildReviewPrescreenBatches,
  collectReviewPrescreenHints,
  selectReviewPrescreenHunks,
  type HunkAnswer,
  type ReviewPrescreenHunk,
} from './githubPrReviewPrescreen';

type ReviewComment = {
  path: string;
  user: { login: string } | null;
  original_commit_id: string;
  original_line: number | null;
  original_start_line: number | null;
  side?: string;
  in_reply_to_id?: number;
};

type PrResult = {
  number: number;
  hunks: number;
  findingHunks: number;
  unscreenedFindings: number;
  scores: Array<{ probability: number; finding: boolean }>;
  hints: number;
  hintHits: number;
  hintedFindingHunks: number;
  latencyMs: number;
};

function gh<T>(args: string[]): T {
  return JSON.parse(
    execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  ) as T;
}

function decisionBackend(): {
  url: string;
  model: string;
  apiKey: string;
} {
  if (process.env.TYPESAFE_API_KEY) {
    return {
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: process.env.TYPESAFE_API_KEY,
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: process.env.OPENROUTER_API_KEY,
    };
  }

  throw new Error('Set TYPESAFE_API_KEY or OPENROUTER_API_KEY');
}

async function decide(
  batch: ReturnType<typeof buildReviewPrescreenBatches>[number],
): Promise<Record<string, HunkAnswer>> {
  const backend = decisionBackend();
  const response = await fetch(backend.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...batch, model: backend.model }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Decision request failed with HTTP ${response.status}`);
  }

  const answers = ((await response.json()) as { answers: object })
    .answers as Record<string, Record<string, unknown>>;

  // OpenRouter reports choice probabilities without TypeSafe's confidence.
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [
      id,
      answer.type === 'choice' && typeof answer.confidence !== 'number'
        ? {
            ...answer,
            confidence: Math.max(
              ...Object.values(
                (answer.probabilities ?? {}) as Record<string, number>,
              ),
            ),
          }
        : answer,
    ]),
  ) as Record<string, HunkAnswer>;
}

/** Rebuild a unified diff from the compare API's per-file patches. */
function compareDiff(repo: string, base: string, head: string): string {
  const compare = gh<{
    files?: Array<{ filename: string; patch?: string }>;
  }>(['api', `repos/${repo}/compare/${base}...${head}`]);

  return (compare.files ?? [])
    .filter((file) => file.patch)
    .map(
      (file) =>
        `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`,
    )
    .join('\n');
}

function contains(hunk: ReviewPrescreenHunk, comment: ReviewComment) {
  const end = comment.original_line!;
  const start = comment.original_start_line ?? end;
  return (
    hunk.file === comment.path && start <= hunk.endLine && end >= hunk.startLine
  );
}

async function evaluatePr(
  repo: string,
  reviewers: ReadonlySet<string>,
  number: number,
): Promise<PrResult | undefined> {
  const pr = gh<{ title: string; base: { sha: string } }>([
    'api',
    `repos/${repo}/pulls/${number}`,
  ]);
  const comments = gh<ReviewComment[][]>([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/pulls/${number}/comments`,
  ])
    .flat()
    .filter(
      (comment) =>
        reviewers.has(comment.user?.login ?? '') &&
        !comment.in_reply_to_id &&
        comment.side !== 'LEFT' &&
        typeof comment.original_line === 'number',
    );

  // Score the first reviewed commit only: later commits may already address
  // earlier findings, which would count fixed code as a miss.
  const commit = comments[0]?.original_commit_id;

  if (!commit) {
    return undefined;
  }

  const findings = comments.filter(
    (comment) => comment.original_commit_id === commit,
  );
  const diff = compareDiff(repo, pr.base.sha, commit);
  const hunks = selectReviewPrescreenHunks(diff);

  if (hunks.length === 0) {
    return undefined;
  }

  const started = Date.now();
  const answers = Object.assign(
    {},
    ...(await Promise.all(
      buildReviewPrescreenBatches({
        title: pr.title,
        changedFiles: [...new Set(hunks.map((hunk) => hunk.file))],
        hunks,
      }).map(decide),
    )),
  ) as Record<string, HunkAnswer>;
  const latencyMs = Date.now() - started;

  const isFinding = hunks.map((hunk) =>
    findings.some((comment) => contains(hunk, comment)),
  );
  const hints = collectReviewPrescreenHints(hunks, answers);
  const hintIndexes = hints.map((hint) =>
    hunks.findIndex(
      (hunk) => hunk.file === hint.file && hunk.startLine === hint.startLine,
    ),
  );

  return {
    number,
    hunks: hunks.length,
    findingHunks: isFinding.filter(Boolean).length,
    unscreenedFindings: findings.filter(
      (comment) => !hunks.some((hunk) => contains(hunk, comment)),
    ).length,
    scores: hunks.map((_, index) => {
      const answer = answers[`h${index}`];
      return {
        probability: answer?.type === 'noul' ? answer.noul : 0,
        finding: isFinding[index]!,
      };
    }),
    hints: hints.length,
    hintHits: hintIndexes.filter((index) => isFinding[index]).length,
    hintedFindingHunks: new Set(hintIndexes.filter((index) => isFinding[index]))
      .size,
    latencyMs,
  };
}

/** Probability a random finding hunk outranks a random non-finding hunk. */
function rocAuc(scores: Array<{ probability: number; finding: boolean }>) {
  const positives = scores.filter((score) => score.finding);
  const negatives = scores.filter((score) => !score.finding);

  if (positives.length === 0 || negatives.length === 0) {
    return Number.NaN;
  }

  let wins = 0;

  for (const positive of positives) {
    for (const negative of negatives) {
      wins +=
        positive.probability > negative.probability
          ? 1
          : positive.probability === negative.probability
            ? 0.5
            : 0;
    }
  }

  return wins / (positives.length * negatives.length);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      reviewer: { type: 'string' },
      limit: { type: 'string', default: '40' },
    },
  });

  if (!values.repo || !values.reviewer) {
    throw new Error(
      'Usage: --repo owner/name --reviewer login[,login] [--limit N]',
    );
  }

  const limit = Number(values.limit);
  const reviewers = new Set(values.reviewer.split(','));
  const candidates = gh<Array<{ number: number }>>([
    'pr',
    'list',
    '--repo',
    values.repo,
    '--state',
    'merged',
    '--limit',
    String(limit * 4),
    '--json',
    'number',
  ]);
  const results: PrResult[] = [];

  for (const { number } of candidates) {
    if (results.length >= limit) {
      break;
    }

    try {
      const result = await evaluatePr(values.repo, reviewers, number);

      if (result) {
        results.push(result);
        console.error(
          `#${number}: hunks=${result.hunks} findingHunks=${result.findingHunks} hints=${result.hints} hits=${result.hintHits} ${result.latencyMs}ms`,
        );
      }
    } catch (error) {
      console.error(
        `#${number}: skipped (${error instanceof Error ? error.message : 'error'})`,
      );
    }
  }

  const sum = (pick: (result: PrResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const totalHunks = sum((result) => result.hunks);
  const findingHunks = sum((result) => result.findingHunks);
  const hints = sum((result) => result.hints);
  const hintHits = sum((result) => result.hintHits);
  const latencies = results.map((result) => result.latencyMs);
  const perPrAuc = results
    .map((result) => rocAuc(result.scores))
    .filter((auc) => !Number.isNaN(auc));

  console.log(
    JSON.stringify(
      {
        pullRequests: results.length,
        hunks: totalHunks,
        findingHunks,
        unscreenedFindings: sum((result) => result.unscreenedFindings),
        baseRate: findingHunks / totalHunks,
        hints,
        prsWithHints: results.filter((result) => result.hints > 0).length,
        hintPrecision: hints ? hintHits / hints : null,
        hintRecall: sum((result) => result.hintedFindingHunks) / findingHunks,
        precisionLiftOverBaseRate: hints
          ? hintHits / hints / (findingHunks / totalHunks)
          : null,
        pooledAuc: rocAuc(results.flatMap((result) => result.scores)),
        medianWithinPrAuc: perPrAuc.length ? percentile(perPrAuc, 0.5) : null,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
        },
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
