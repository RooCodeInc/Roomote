import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Env } from '@roomote/env';
import { getArtifactStorageKey } from '@roomote/types';

import {
  generateDownloadUrl,
  generateUploadUrl,
} from '../src/handlers/artifacts/storage.js';

// Sandbox-only: no Docker daemon, public listener, or production credentials.
assert.equal(process.platform, 'linux');
assert.equal(Env.APP_ENV, 'development');
assert.equal(Env.S3_ENDPOINT, 'http://localhost:19000');
assert.equal(Env.S3_PRESIGN_ENDPOINT ?? Env.S3_ENDPOINT, Env.S3_ENDPOINT);
const release = 'RELEASE.2025-09-07T16-13-09Z';
const builds: Record<string, { platform: string; sha256: string }> = {
  x64: {
    platform: 'linux-amd64',
    sha256: '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f',
  },
  arm64: {
    platform: 'linux-arm64',
    sha256: '5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d',
  },
};
const build = builds[process.arch];
assert.ok(build, 'MinIO sandbox bootstrap supports Linux x64 and arm64');
const directory = join(homedir(), '.cache', 'roomote-minio');
await mkdir(directory, { recursive: true, mode: 0o700 });
const binary = join(directory, `minio.${release}`);
const checksum = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
try {
  assert.equal(await checksum(binary), build.sha256);
} catch {
  const temporary = `${binary}.${randomUUID()}.tmp`;
  try {
    execFileSync('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '2',
      '--connect-timeout',
      '15',
      '--max-time',
      '120',
      '--output',
      temporary,
      `https://dl.min.io/server/minio/release/${build.platform}/archive/minio.${release}`,
    ]);
    assert.equal(
      await checksum(temporary),
      build.sha256,
      'MinIO checksum mismatch',
    );
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
  } finally {
    await rm(temporary, { force: true });
  }
}

const processName = 'roomote-sandbox-minio';
const pm2 = (args: string[]) =>
  execFileSync('pm2', args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      MINIO_ROOT_USER: Env.S3_ACCESS_KEY_ID,
      MINIO_ROOT_PASSWORD: Env.S3_SECRET_ACCESS_KEY,
      MINIO_BROWSER: 'off',
    },
  });
const processes = JSON.parse(pm2(['jlist'])) as {
  name: string;
  pm2_env: { pm_exec_path: string; status: string };
}[];
const existing = processes.find((entry) => entry.name === processName);
if (existing) {
  assert.equal(
    existing.pm2_env.pm_exec_path,
    binary,
    'Unexpected MinIO process; inspect PM2 before replacing it',
  );
  if (existing.pm2_env.status !== 'online')
    pm2(['restart', processName, '--update-env']);
} else {
  pm2([
    'start',
    binary,
    '--name',
    processName,
    '--interpreter',
    'none',
    '--restart-delay',
    '1000',
    '--',
    'server',
    join(directory, 'data'),
    '--address',
    '127.0.0.1:19000',
  ]);
}

const s3 = new S3Client({
  endpoint: Env.S3_ENDPOINT,
  region: Env.S3_REGION,
  credentials: {
    accessKeyId: Env.S3_ACCESS_KEY_ID,
    secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  maxAttempts: 2,
  requestHandler: { requestTimeout: 5_000, connectionTimeout: 5_000 },
});
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    const ready = await fetch(`${Env.S3_ENDPOINT}/minio/health/ready`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    assert.ok(
      Date.now() < deadline,
      'MinIO readiness timed out; inspect pm2 logs roomote-sandbox-minio',
    );
    await delay(500);
  }
  const Bucket = Env.S3_BUCKET_ARTIFACTS;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode !== 404
    )
      throw error;
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
  await s3.send(new HeadBucketCommand({ Bucket }));

  // Exercise the actual application's presigner as well as its server endpoint.
  const id = randomUUID();
  const path = 'sandbox-readiness.txt';
  const Key = getArtifactStorageKey({ taskId: id }, id, path, 1);
  const body = `roomote-sandbox-storage-${id}`;
  try {
    const upload = await fetch(
      await generateUploadUrl(id, id, path, 1, 'text/plain', body.length),
      {
        method: 'PUT',
        body,
        headers: { 'Content-Type': 'text/plain' },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.ok(upload.ok, `Artifact upload failed: ${upload.status}`);
    const download = await fetch(await generateDownloadUrl(id, id, path, 1), {
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(download.ok, `Artifact download failed: ${download.status}`);
    assert.equal(await download.text(), body);
    const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
    assert.equal(await object.Body?.transformToString(), body);
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket, Key }));
  }
  await assert.rejects(
    s3.send(new HeadObjectCommand({ Bucket, Key })),
    (error: { $metadata?: { httpStatusCode?: number } }) =>
      error.$metadata?.httpStatusCode === 404,
  );
  console.log(
    'Local MinIO ready; private artifacts bucket and application upload/read/delete verified.',
  );
} catch (error) {
  // Do not leave a newly created restart loop behind when setup fails.
  if (!existing) pm2(['delete', processName]);
  throw error;
} finally {
  s3.destroy();
}
