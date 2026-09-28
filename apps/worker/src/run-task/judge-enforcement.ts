import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import ignore from 'ignore';
import { execa } from 'execa';

import {
  JUDGE_DEFAULT_THRESHOLD,
  JUDGE_MAX_FILE_CONTEXT_BYTES,
  JUDGE_MAX_PATCH_CONTEXT_BYTES,
  JUDGE_POLICY_FILE_NAME,
  judgePolicySchema,
  type JudgeCriterion,
  type JudgeFileState,
  type JudgeOutcome,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

import type { HarnessLogger } from '../logging';

type RuntimeEventRecorder = (input: {
  eventType: 'decision';
  message: string;
  details?: Record<string, unknown>;
}) => Promise<void>;

type JudgeRepository = {
  name: string;
  root: string;
  policyPath: string;
  policy: { criteria: JudgeCriterion[] };
  policyBytes: Buffer;
  policyHash: string;
  initialDirtyHashes: Map<string, string | null>;
};

type JudgePolicySnapshot = {
  name: string;
  policyPath: string;
  policyBytes: Buffer | null;
  policyHash: string | null;
};

type FileContext = {
  hash: string;
  content: string;
  contentTruncated: boolean;
};

type JudgeFile = JudgeFileState & {
  repository: JudgeRepository;
  relativePath: string;
  contentHash: string;
};

type JudgeEvaluation = {
  id: string;
  outcome: JudgeOutcome;
  confidence: number;
  probabilities: Record<JudgeOutcome, number>;
};

type JudgeCompletionResult =
  | 'finalize'
  | { disposition: 'fail'; error: string }
  | {
      disposition: 'continue';
      prompt: {
        prompt: string;
        autoSteerWhenQueued: true;
        visibleInTranscript: true;
        source: string;
      };
    };

const POLICY_WARNING_MESSAGE =
  'Repository judge enforcement is disabled for this task because JUDGE.json is invalid.';
const MODEL_UNAVAILABLE_WARNING_MESSAGE =
  'Repository judge could not run because the judgment model is unavailable; allowing task completion.';
const MODEL_ERROR_WARNING_MESSAGE =
  'Repository judge could not run because the judgment model returned an error; allowing task completion.';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseNullSeparatedPaths(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0);
}

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd: root,
    reject: false,
    maxBuffer: 1_000_000,
  });

  return result.stdout;
}

async function getDirtyPaths(root: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(root, ['diff', '--name-only', '-z', 'HEAD', '--']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  return [
    ...new Set([
      ...parseNullSeparatedPaths(tracked),
      ...parseNullSeparatedPaths(untracked),
    ]),
  ];
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }

    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function boundedText(
  value: Buffer,
  maxBytes: number,
): {
  text: string;
  truncated: boolean;
} {
  if (value.byteLength <= maxBytes) {
    return { text: value.toString('utf8'), truncated: false };
  }

  const marker = Buffer.from('\n... bounded context omitted ...\n');
  const remaining = Math.max(0, maxBytes - marker.byteLength);
  const startBytes = Math.ceil(remaining / 2);
  const endBytes = remaining - startBytes;

  return {
    text: Buffer.concat([
      value.subarray(0, startBytes),
      marker,
      value.subarray(value.byteLength - endBytes),
    ]).toString('utf8'),
    truncated: true,
  };
}

async function readFileContext(filePath: string): Promise<FileContext | null> {
  try {
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const hash = createHash('sha256');
    const firstChunks: Buffer[] = [];
    let firstBytes = 0;
    let tail = Buffer.alloc(0);
    let totalBytes = 0;
    let binary = false;
    const sampleLimit = Math.max(
      JUDGE_MAX_FILE_CONTEXT_BYTES,
      JUDGE_MAX_PATCH_CONTEXT_BYTES,
    );

    for await (const rawChunk of stream) {
      const chunk = rawChunk as Buffer;
      totalBytes += chunk.byteLength;
      hash.update(chunk);
      binary ||= chunk.includes(0);

      if (firstBytes < sampleLimit) {
        const next = chunk.subarray(0, sampleLimit - firstBytes);
        firstChunks.push(next);
        firstBytes += next.byteLength;
      }

      tail = Buffer.concat([tail, chunk]);
      if (tail.byteLength > sampleLimit) {
        tail = tail.subarray(tail.byteLength - sampleLimit);
      }
    }

    if (binary) {
      return null;
    }

    const first = Buffer.concat(firstChunks);
    const content =
      totalBytes <= JUDGE_MAX_FILE_CONTEXT_BYTES
        ? first
        : Buffer.concat([first, tail]);
    const bounded = boundedText(content, JUDGE_MAX_FILE_CONTEXT_BYTES);

    return {
      hash: hash.digest('hex'),
      content: bounded.text,
      contentTruncated: totalBytes > JUDGE_MAX_FILE_CONTEXT_BYTES,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function readFullFileHash(filePath: string): Promise<string | null> {
  return await hashFile(filePath);
}

function isRootPolicyPath(relativePath: string): boolean {
  return relativePath === JUDGE_POLICY_FILE_NAME;
}

function matchesCriterion(
  criterion: JudgeCriterion,
  relativePath: string,
): boolean {
  if (!criterion.files) {
    return true;
  }

  return criterion.files.some((pattern) => {
    try {
      return ignore().add(pattern).ignores(relativePath);
    } catch {
      return false;
    }
  });
}

async function readPolicySnapshot(
  name: string,
  root: string,
): Promise<JudgeRepository | null> {
  const policyPath = path.join(root, JUDGE_POLICY_FILE_NAME);

  let policyBytes: Buffer;
  try {
    const stats = await lstat(policyPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('JUDGE.json is not a regular file');
    }
    policyBytes = await readFile(policyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const parsed = JSON.parse(policyBytes.toString('utf8')) as unknown;
  const policy = judgePolicySchema.parse(parsed);
  const initialDirtyHashes = new Map<string, string | null>();

  for (const relativePath of await getDirtyPaths(root)) {
    initialDirtyHashes.set(
      relativePath,
      await readFullFileHash(path.join(root, relativePath)),
    );
  }

  return {
    name,
    root,
    policyPath,
    policy,
    policyBytes,
    policyHash: sha256(policyBytes),
    initialDirtyHashes,
  };
}

async function getPatch(root: string, relativePath: string): Promise<string> {
  const trackedPatch = await runGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--unified=40',
    'HEAD',
    '--',
    relativePath,
  ]);

  if (trackedPatch) {
    return boundedText(Buffer.from(trackedPatch), JUDGE_MAX_PATCH_CONTEXT_BYTES)
      .text;
  }

  const untrackedPatch = await execa(
    'git',
    [
      'diff',
      '--no-index',
      '--no-color',
      '--unified=40',
      '--',
      '/dev/null',
      relativePath,
    ],
    {
      cwd: root,
      reject: false,
      maxBuffer: 1_000_000,
    },
  );

  return boundedText(
    Buffer.from(untrackedPatch.stdout),
    JUDGE_MAX_PATCH_CONTEXT_BYTES,
  ).text;
}

async function changedFiles(repository: JudgeRepository): Promise<JudgeFile[]> {
  const files: JudgeFile[] = [];
  const paths = await getDirtyPaths(repository.root);

  for (const relativePath of paths) {
    const normalizedPath = relativePath.replaceAll('\\', '/');
    if (isRootPolicyPath(normalizedPath)) {
      continue;
    }

    const filePath = path.join(repository.root, relativePath);
    const initialHash = repository.initialDirtyHashes.get(relativePath);
    if (repository.initialDirtyHashes.has(relativePath)) {
      const currentHash = await readFullFileHash(filePath);
      if (currentHash === initialHash) {
        continue;
      }
    }

    const context = await readFileContext(filePath);
    if (!context) {
      continue;
    }

    const applicableCriteria = repository.policy.criteria.filter((criterion) =>
      matchesCriterion(criterion, normalizedPath),
    );
    if (applicableCriteria.length === 0) {
      continue;
    }

    const patch = await getPatch(repository.root, relativePath);
    const patchTruncated =
      Buffer.byteLength(patch) >= JUDGE_MAX_PATCH_CONTEXT_BYTES;

    files.push({
      repository,
      relativePath: normalizedPath,
      contentHash: context.hash,
      path: normalizedPath,
      patch,
      patchTruncated,
      finalContent: context.content,
      finalContentTruncated: context.contentTruncated,
    });
  }

  return files;
}

async function restorePolicySnapshot(
  snapshot: JudgePolicySnapshot,
): Promise<boolean> {
  try {
    const stats = await lstat(snapshot.policyPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    });

    if (stats?.isSymbolicLink()) {
      return false;
    }

    if (snapshot.policyBytes === null) {
      await unlink(snapshot.policyPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    } else {
      await writeFile(snapshot.policyPath, snapshot.policyBytes, { flag: 'w' });
    }

    return true;
  } catch {
    return false;
  }
}

function buildRepairPrompt(
  violations: Array<{
    path: string;
    rule: string;
    confidence: number;
    bounded: boolean;
  }>,
): string {
  return [
    'Repository judge feedback: repair the following confirmed policy violations before ending this turn.',
    ...violations.flatMap((violation) => [
      `Path: ${violation.path}`,
      `Rule: ${violation.rule}`,
      `Confidence: ${violation.confidence.toFixed(2)}`,
      ...(violation.bounded
        ? [
            'The judge saw bounded file context; inspect the complete file before repairing it.',
          ]
        : []),
    ]),
    'Make the smallest repair that satisfies each exact rule. Do not edit JUDGE.json. Re-check the changed files before ending this turn.',
  ].join('\n');
}

export async function createJudgeEnforcement(options: {
  runId: number;
  repoPaths?: Record<string, string>;
  logger: HarnessLogger;
  recordWorkerRuntimeEvent?: RuntimeEventRecorder;
  evaluate?: (input: {
    runId: number;
    state: JudgeFileState;
    criteria: Array<{ id: string; rule: string }>;
  }) => Promise<
    | { kind: 'answered'; evaluations: JudgeEvaluation[] }
    | { kind: 'unavailable' }
    | { kind: 'error' }
  >;
}): Promise<{
  beforeTaskCompletion: () => Promise<JudgeCompletionResult>;
}> {
  const recordWarning = async (message: string, reason: string) => {
    options.logger.warn(`[judge] ${message}`);
    await options.recordWorkerRuntimeEvent?.({
      eventType: 'decision',
      message,
      details: { reason },
    });
  };

  const repositories: JudgeRepository[] = [];
  const policySnapshots: JudgePolicySnapshot[] = [];
  let invalidPolicy = false;

  for (const [name, root] of Object.entries(options.repoPaths ?? {})) {
    const policyPath = path.join(root, JUDGE_POLICY_FILE_NAME);
    try {
      const repository = await readPolicySnapshot(name, root);
      if (repository) {
        repositories.push(repository);
        policySnapshots.push({
          name,
          policyPath,
          policyBytes: repository.policyBytes,
          policyHash: repository.policyHash,
        });
      } else {
        policySnapshots.push({
          name,
          policyPath,
          policyBytes: null,
          policyHash: null,
        });
      }
    } catch {
      invalidPolicy = true;
      await recordWarning(POLICY_WARNING_MESSAGE, 'judge_policy_invalid');
      break;
    }
  }

  if (invalidPolicy || policySnapshots.length === 0) {
    return {
      beforeTaskCompletion: async () => 'finalize',
    };
  }

  const evaluate =
    options.evaluate ??
    (async (input) => await sdk.taskRuns.evaluateJudgeFileCriteria(input));
  const judgmentCache = new Map<string, JudgeEvaluation>();
  const repairRounds = new Map<string, number>();
  const pendingRepairs = new Set<string>();
  let modelWarningRecorded = false;

  const recordModelWarning = async (message: string, reason: string) => {
    if (modelWarningRecorded) return;
    modelWarningRecorded = true;
    await recordWarning(message, reason);
  };

  return {
    beforeTaskCompletion: async () => {
      try {
        for (const snapshot of policySnapshots) {
          const currentPolicy = await hashFile(snapshot.policyPath);
          if (currentPolicy !== snapshot.policyHash) {
            if (!(await restorePolicySnapshot(snapshot))) {
              return {
                disposition: 'fail' as const,
                error: `JUDGE.json in ${snapshot.name} changed during this task and could not be restored. Restore it to its startup contents before completing the task.`,
              };
            }
          }
        }
      } catch {
        await recordModelWarning(
          MODEL_ERROR_WARNING_MESSAGE,
          'judge_workspace_observation_error',
        );
        return 'finalize';
      }

      const violations: Array<{
        key: string;
        path: string;
        rule: string;
        confidence: number;
        bounded: boolean;
      }> = [];

      for (const repository of repositories) {
        let files: JudgeFile[];
        try {
          files = await changedFiles(repository);
        } catch {
          await recordModelWarning(
            MODEL_ERROR_WARNING_MESSAGE,
            'judge_workspace_observation_error',
          );
          return 'finalize';
        }

        for (const file of files) {
          const applicableCriteria = repository.policy.criteria
            .map((criterion, index) => ({ criterion, index }))
            .filter(({ criterion }) =>
              matchesCriterion(criterion, file.relativePath),
            );
          const pendingCriteria = applicableCriteria.filter(({ index }) => {
            const cacheKey = `${repository.policyHash}:${index}:${file.relativePath}:${file.contentHash}`;
            return !judgmentCache.has(cacheKey);
          });

          if (pendingCriteria.length > 0) {
            let result:
              | { kind: 'answered'; evaluations: JudgeEvaluation[] }
              | { kind: 'unavailable' }
              | { kind: 'error' };

            try {
              result = await evaluate({
                runId: options.runId,
                state: {
                  path: file.path,
                  patch: file.patch,
                  patchTruncated: file.patchTruncated,
                  finalContent: file.finalContent,
                  finalContentTruncated: file.finalContentTruncated,
                },
                criteria: pendingCriteria.map(({ index, criterion }) => ({
                  id: `criterion_${index}`,
                  rule: criterion.rule,
                })),
              });
            } catch {
              result = { kind: 'error' };
            }

            if (result.kind === 'unavailable') {
              await recordModelWarning(
                MODEL_UNAVAILABLE_WARNING_MESSAGE,
                'judge_model_unavailable',
              );
              return 'finalize';
            }

            if (result.kind === 'error') {
              await recordModelWarning(
                MODEL_ERROR_WARNING_MESSAGE,
                'judge_model_error',
              );
              return 'finalize';
            }

            for (const evaluation of result.evaluations) {
              const index = Number(evaluation.id.replace('criterion_', ''));
              const cacheKey = `${repository.policyHash}:${index}:${file.relativePath}:${file.contentHash}`;
              judgmentCache.set(cacheKey, evaluation);
            }

            if (
              pendingCriteria.some(
                ({ index }) =>
                  !judgmentCache.has(
                    `${repository.policyHash}:${index}:${file.relativePath}:${file.contentHash}`,
                  ),
              )
            ) {
              await recordModelWarning(
                MODEL_ERROR_WARNING_MESSAGE,
                'judge_model_error',
              );
              return 'finalize';
            }
          }

          for (const { criterion, index } of applicableCriteria) {
            const cacheKey = `${repository.policyHash}:${index}:${file.relativePath}:${file.contentHash}`;
            const evaluation = judgmentCache.get(cacheKey);
            if (!evaluation) continue;

            const threshold = criterion.threshold ?? JUDGE_DEFAULT_THRESHOLD;
            const isViolation =
              evaluation.outcome === 'rewrite' &&
              evaluation.confidence >= threshold;

            const repairKey = `${repository.name}:${index}:${file.relativePath}`;
            if (!isViolation) {
              repairRounds.delete(repairKey);
              pendingRepairs.delete(repairKey);
              continue;
            }

            if (pendingRepairs.has(repairKey)) {
              const nextRound = (repairRounds.get(repairKey) ?? 0) + 1;
              repairRounds.set(repairKey, nextRound);
              if (nextRound >= 3) {
                return {
                  disposition: 'fail' as const,
                  error: `Repository judge still found a violation in ${file.relativePath} after three repair rounds.`,
                };
              }
            }

            pendingRepairs.add(repairKey);
            violations.push({
              key: repairKey,
              path: file.relativePath,
              rule: criterion.rule,
              confidence: evaluation.confidence,
              bounded: file.finalContentTruncated || file.patchTruncated,
            });
          }
        }
      }

      if (violations.length === 0) {
        return 'finalize';
      }

      return {
        disposition: 'continue' as const,
        prompt: {
          prompt: buildRepairPrompt(violations),
          autoSteerWhenQueued: true as const,
          visibleInTranscript: true as const,
          source: 'roomote-judge',
        },
      };
    },
  };
}
