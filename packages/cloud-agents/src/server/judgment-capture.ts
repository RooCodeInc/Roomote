import { randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Env } from '@roomote/env';

import { scrubForMemoryCheck } from './memory-check-scrub';
import type { TypeSafeQuestion } from './typesafe-judgment';

/**
 * Records typed decisions for building a training set, when a deployment
 * opts in with `R_JUDGMENT_CAPTURE=on`. Each decision that a judgment or
 * helper model answered is written as one JSON object to the deployment's
 * own artifact bucket under `judgment-capture/`, with the state, the
 * questions, and the answer the caller acted on. Nothing leaves the
 * deployment; an operator collects the objects from the bucket.
 *
 * The write runs detached after the caller has its answer, swallows its own
 * failures, and is bounded per process so a busy deployment cannot fill its
 * bucket: at most `MAX_CAPTURES_PER_HOUR` objects, none over `MAX_BYTES`.
 * Every string in the state is scrubbed the way the memory checks scrub
 * their input, so credential shapes and structured personal data never land
 * in an object. Free-form names and details can still be present, which is
 * why this is off by default and meant for deployments the operator owns.
 */
const CAPTURE_PREFIX = 'judgment-capture';
const MAX_BYTES = 256 * 1024;
const MAX_CAPTURES_PER_HOUR = 600;

export type JudgmentCaptureRecord = {
  version: 1;
  capturedAt: string;
  /** Which model answered, so records can be filtered by label source. */
  answeredBy: 'roomote' | 'typesafe' | 'openrouter' | 'vercel' | 'helper';
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  answers: Record<string, unknown>;
};

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  s3Client ??= new S3Client({
    endpoint: Env.S3_ENDPOINT,
    region: Env.S3_REGION,
    credentials: {
      accessKeyId: Env.S3_ACCESS_KEY_ID,
      secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return s3Client;
}

/** Fixed-window count of captures this process wrote in the current hour. */
let windowStart = 0;
let windowCount = 0;

function admit(now: number): boolean {
  if (now - windowStart >= 60 * 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_CAPTURES_PER_HOUR) return false;
  windowCount += 1;
  return true;
}

/** Scrub every string leaf; leave structure and other scalars alone. */
export function scrubJudgmentState(value: unknown): unknown {
  if (typeof value === 'string') return scrubForMemoryCheck(value);
  if (Array.isArray(value)) return value.map(scrubJudgmentState);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        scrubJudgmentState(entry),
      ]),
    );
  }
  return value;
}

export function isJudgmentCaptureEnabled(): boolean {
  return Env.R_JUDGMENT_CAPTURE === 'on';
}

/**
 * Write one decision to the capture prefix. Never throws and never delays
 * the caller: call it with `void` after the answer is in hand.
 */
export async function captureJudgment(params: {
  answeredBy: JudgmentCaptureRecord['answeredBy'];
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  answers: Record<string, unknown>;
  /** Test seam. */
  send?: (command: PutObjectCommand) => Promise<unknown>;
  now?: () => number;
}): Promise<void> {
  try {
    const now = (params.now ?? Date.now)();
    if (!admit(now)) return;

    const record: JudgmentCaptureRecord = {
      version: 1,
      capturedAt: new Date(now).toISOString(),
      answeredBy: params.answeredBy,
      state: scrubJudgmentState(params.state),
      questions: params.questions,
      answers: params.answers,
    };
    const body = Buffer.from(JSON.stringify(record), 'utf8');
    if (body.length > MAX_BYTES) return;

    const day = record.capturedAt.slice(0, 10);
    const command = new PutObjectCommand({
      Bucket: Env.S3_BUCKET_ARTIFACTS,
      Key: `${CAPTURE_PREFIX}/${day}/${now}-${randomUUID()}.json`,
      Body: body,
      ContentType: 'application/json',
    });
    await (params.send ?? ((c) => getS3Client().send(c)))(command);
  } catch (error) {
    console.warn(
      `[JudgmentCapture] Failed to write a decision: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Test seam: forget the hourly window. */
export function resetJudgmentCaptureWindow(): void {
  windowStart = 0;
  windowCount = 0;
}
