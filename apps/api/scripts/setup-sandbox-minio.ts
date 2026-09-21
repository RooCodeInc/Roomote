import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
const release = 'RELEASE.2025-10-15T17-29-55Z';
const previousRelease = 'RELEASE.2025-09-07T16-13-09Z';
const sourceVersion = 'v0.0.0-20251015172955-9e49d5e7a648';
const sourceSum = 'h1:6TdolSCLSs2nwm8i0PpWDqf9iX2Ty9WQK8wmr7dCnUM=';
const sourceGoModSum = 'h1:yCWDkwWO9IWpGsT4mreDDN/B/QVmK2zC666uInRAcqE=';
const builds: Record<string, { goarch: string; sha256: string }> = {
  x64: {
    goarch: 'amd64',
    sha256: '6456634c06fa937dfeb708e37db80c8a02ffc50874d211ee3fc5cc0f71f95b96',
  },
  arm64: {
    goarch: 'arm64',
    sha256: '3f9e2d92ca9fe43ebac8f069349a3fefb91500ed06b22697e9d9f3dba6e1db17',
  },
};
const resolvedBuild = builds[process.arch];
assert.ok(
  resolvedBuild,
  'MinIO sandbox bootstrap supports Linux x64 and arm64',
);
const build: { goarch: string; sha256: string } = resolvedBuild;
const directory = join(homedir(), '.cache', 'roomote-minio');
await mkdir(directory, { recursive: true, mode: 0o700 });
const binary = join(directory, `minio.${release}`);
const previousBinary = join(directory, `minio.${previousRelease}`);
const checksum = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
// The published roomote-minio image holds this exact binary (same pins, same
// checksum), so a cold sandbox takes it from the registry instead of spending
// most of a minute compiling it. The deployment catalog names the image; the
// pinned SHA-256 above still decides whether the result is accepted.
const publishedBinaryPath = 'usr/local/bin/minio';
async function downloadPublishedBinary(destination: string): Promise<boolean> {
  const catalog = JSON.parse(
    await readFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../deploy/deployment-catalog.json',
      ),
      'utf8',
    ),
  ) as { criticalImages: { minio: string } };
  const image = catalog.criticalImages.minio.match(
    /^ghcr\.io\/([^:@]+):[^@]+@(sha256:[0-9a-f]{64})$/,
  );
  assert.ok(image, 'Unexpected MinIO image reference in deployment catalog');
  const repository = image[1] as string;
  const indexDigest = image[2] as string;
  const registry = `https://ghcr.io/v2/${repository}`;
  const request = async (url: string, headers: Record<string, string> = {}) => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `${new URL(url).pathname}: ${response.status}`);
    return response;
  };
  const { token } = (await (
    await request(`https://ghcr.io/token?scope=repository:${repository}:pull`)
  ).json()) as { token: string };
  const manifest = async <T>(digest: string) =>
    (await (
      await request(`${registry}/manifests/${digest}`, {
        Authorization: `Bearer ${token}`,
        Accept:
          'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json',
      })
    ).json()) as T;
  const index = await manifest<{
    manifests: {
      digest: string;
      platform?: { architecture: string; os: string };
    }[];
  }>(indexDigest);
  const platform = index.manifests.find(
    (entry) =>
      entry.platform?.os === 'linux' &&
      entry.platform.architecture === build.goarch,
  );
  assert.ok(platform, `No linux/${build.goarch} image in ${indexDigest}`);
  const { layers } = await manifest<{
    layers: { digest: string; size: number }[];
  }>(platform.digest);
  const workingDirectory = dirname(destination);
  const archive = join(workingDirectory, 'layer.tar.gz');
  // The binaries are the bulk of the image, so their layer is the largest.
  for (const layer of [...layers].sort((a, b) => b.size - a.size)) {
    const blob = await request(`${registry}/blobs/${layer.digest}`, {
      Authorization: `Bearer ${token}`,
    });
    await writeFile(archive, Buffer.from(await blob.arrayBuffer()));
    try {
      execFileSync(
        'tar',
        ['-xzf', archive, '-C', workingDirectory, publishedBinaryPath],
        { stdio: 'ignore', timeout: 60_000 },
      );
    } catch {
      continue;
    } finally {
      await rm(archive, { force: true });
    }
    await rename(join(workingDirectory, publishedBinaryPath), destination);
    return (await checksum(destination)) === build.sha256;
  }
  return false;
}

try {
  assert.equal(await checksum(binary), build.sha256);
} catch {
  const temporaryDirectory = join(directory, `.build.${randomUUID()}`);
  const temporary = join(temporaryDirectory, 'minio');
  try {
    await mkdir(temporaryDirectory, { mode: 0o700 });
    const downloaded = await downloadPublishedBinary(temporary).catch(
      (error: unknown) => {
        console.warn(
          `Published MinIO binary unavailable, building from source: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      },
    );
    if (!downloaded) await buildFromSource(temporary);
    assert.equal(
      await checksum(temporary),
      build.sha256,
      'MinIO checksum mismatch',
    );
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function buildFromSource(temporary: string): Promise<void> {
  const goEnvironment = {
    ...process.env,
    CGO_ENABLED: '0',
    GOARCH: build.goarch,
    GOENV: 'off',
    GONOSUMDB: '',
    GOOS: 'linux',
    GOPRIVATE: '',
    GOPROXY: 'https://proxy.golang.org',
    GOSUMDB: 'sum.golang.org',
    GOTOOLCHAIN: 'local',
  };
  const go = execFileSync('mise', ['which', 'go'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(
    execFileSync(go, ['version'], {
      encoding: 'utf8',
      env: goEnvironment,
    }).trim(),
    `go version go1.24.8 linux/${build.goarch}`,
    'MinIO build requires the repository-pinned Go toolchain',
  );
  // Community MinIO is source-only; the Go checksum database authenticates
  // the pinned upstream module before a reproducible, checksum-pinned build.
  const source = JSON.parse(
    execFileSync(
      go,
      ['mod', 'download', '-json', `github.com/minio/minio@${release}`],
      {
        encoding: 'utf8',
        env: goEnvironment,
        timeout: 120_000,
      },
    ),
  ) as { Dir: string; GoModSum: string; Sum: string; Version: string };
  assert.equal(source.Version, sourceVersion, 'Unexpected MinIO source');
  assert.equal(source.Sum, sourceSum, 'MinIO source checksum mismatch');
  assert.equal(
    source.GoModSum,
    sourceGoModSum,
    'MinIO module checksum mismatch',
  );
  // Same flags as .docker/minio (the published roomote-minio image):
  // -buildid= drops the toolchain-derived build ID and -s -w the debug
  // info, as upstream's release builds did. The pinned checksums are for
  // NATIVE builds only: MinIO's compiled code still differs when the Go
  // compiler runs on a different host architecture than it targets, so a
  // cross-compile (for example arm64 from an amd64 host) will not match
  // and must never be used to refresh these pins. This script only ever
  // builds natively, so that constraint holds here by construction.
  execFileSync(
    go,
    ['build', '-trimpath', '-ldflags=-buildid= -s -w', '-o', temporary, '.'],
    {
      cwd: source.Dir,
      stdio: 'inherit',
      timeout: 540_000,
      env: {
        ...goEnvironment,
        GOFLAGS: '-mod=readonly',
      },
    },
  );
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
const upgrading = existing?.pm2_env.pm_exec_path === previousBinary;
if (upgrading) pm2(['delete', processName]);
if (existing && !upgrading) {
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
  if (!existing || upgrading) pm2(['delete', processName]);
  throw error;
} finally {
  s3.destroy();
}
