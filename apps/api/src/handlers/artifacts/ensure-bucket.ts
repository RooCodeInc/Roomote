import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Env, isEnvFlagEnabled } from '@roomote/env';

// Spread so a MinIO container that boots alongside the api (compose, PaaS
// templates) has time to accept connections before the last attempt.
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Whether the deployment opted into creating the artifacts bucket at boot
 * (`S3_AUTO_CREATE_BUCKET=true`). Opt-in because bucket creation against
 * external stores is not always desired (AWS bucket names are global) or
 * permitted by the configured credentials.
 */
export function isAutoCreateBucketEnabled(
  value: string | undefined = Env.S3_AUTO_CREATE_BUCKET,
): boolean {
  return isEnvFlagEnabled(value);
}

function getErrorStatusCode(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function isMissingBucketError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'NotFound' ||
    error.name === 'NoSuchBucket' ||
    getErrorStatusCode(error) === 404
  );
}

function isBucketAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'BucketAlreadyOwnedByYou' ||
    error.name === 'BucketAlreadyExists'
  );
}

// A service response with a 4xx status (AccessDenied, invalid bucket name,
// wrong-region redirect) will not change on retry; only connection-class
// failures and 5xx responses can be a store that is still booting.
function isRetryableEnsureBucketError(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error);
  return statusCode === undefined || statusCode >= 500;
}

export interface EnsureArtifactsBucketOptions {
  enabled?: boolean;
  bucket?: string;
  client?: S3Client;
  retryDelaysMs?: number[];
  log?: (message: string) => void;
  warn?: (message: string, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Creates the artifacts bucket when it does not exist yet. Never throws: a
 * deployment that cannot create the bucket (external store, restricted
 * credentials) keeps booting and artifact operations surface their own
 * errors until the bucket is created manually.
 */
export async function ensureArtifactsBucketAtBoot(
  options: EnsureArtifactsBucketOptions = {},
): Promise<void> {
  if (!(options.enabled ?? isAutoCreateBucketEnabled())) {
    return;
  }

  const bucket = options.bucket ?? Env.S3_BUCKET_ARTIFACTS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const log = options.log ?? ((message) => console.log(message));
  const warn =
    options.warn ?? ((message, error) => console.warn(message, error));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const ownsClient = !options.client;
  const client =
    options.client ??
    new S3Client({
      endpoint: Env.S3_ENDPOINT,
      region: Env.S3_REGION,
      credentials: {
        accessKeyId: Env.S3_ACCESS_KEY_ID,
        secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        try {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
          return;
        } catch (error) {
          if (!isMissingBucketError(error)) {
            throw error;
          }
        }

        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          log(`[artifacts-bucket] Created S3 bucket "${bucket}".`);
        } catch (error) {
          if (!isBucketAlreadyExistsError(error)) {
            throw error;
          }
        }

        return;
      } catch (error) {
        if (
          !isRetryableEnsureBucketError(error) ||
          attempt >= retryDelaysMs.length
        ) {
          warn(
            `[artifacts-bucket] Could not ensure S3 bucket "${bucket}" exists; ` +
              'artifact storage will fail until the bucket is created manually.',
            error,
          );
          return;
        }

        await sleep(retryDelaysMs[attempt]!);
      }
    }
  } finally {
    if (ownsClient) {
      client.destroy();
    }
  }
}
