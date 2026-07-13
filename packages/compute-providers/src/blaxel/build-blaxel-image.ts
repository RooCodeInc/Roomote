import { ImageInstance, SandboxInstance, settings } from '@blaxel/core';
import { WORKER_RUNTIME_SCHEMA_TAG } from '@roomote/types';

export const BLAXEL_WORKER_IMAGE_NAME_PREFIX = 'roomote-worker';

export interface BuildBlaxelWorkerImageOptions {
  apiKey: string;
  workspace: string;
  /** Registry-qualified Roomote worker image used as the build source. */
  imageRef: string;
  /** Overrides the deterministic Blaxel sandbox resource name. */
  imageName?: string;
  memoryMiB?: number;
  timeoutMs?: number;
  onStatusChange?: (status: string) => void;
}

export interface BuiltBlaxelWorkerImage {
  /** Immutable image reference suitable for `BLAXEL_IMAGE`. */
  imageRef: string;
  imageName: string;
}

const BLAXEL_DOCKER_ENTRYPOINT = `#!/bin/sh
set -eu
export DOCKER_INSECURE_NO_IPTABLES_RAW=1
/usr/local/bin/sandbox-api &
echo 1 > /proc/sys/net/ipv4/ip_forward
mkdir -p /sys/fs/cgroup /etc/docker
mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true
printf '{"storage-driver":"vfs"}\\n' > /etc/docker/daemon.json
exec dockerd --config-file=/etc/docker/daemon.json --log-level=error --host=unix:///run/docker.sock
`;

const BLAXEL_DOCKER_ENTRYPOINT_COMMAND = `printf '%s' '${Buffer.from(
  BLAXEL_DOCKER_ENTRYPOINT,
).toString(
  'base64',
)}' | base64 -d | sudo tee /entrypoint.sh >/dev/null && sudo chmod 0755 /entrypoint.sh`;

function createBlaxelWorkerImage(imageRef: string): ImageInstance {
  return ImageInstance.fromRegistry(imageRef)
    .runCommands(
      'sudo update-alternatives --set iptables /usr/sbin/iptables-legacy',
      'sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy',
      'sudo docker compose version',
      BLAXEL_DOCKER_ENTRYPOINT_COMMAND,
    )
    .entrypoint('/entrypoint.sh');
}

export function deriveBlaxelWorkerImageName(imageRef: string): string {
  if (!imageRef.includes('/')) {
    throw new Error(
      `Blaxel image builds need a registry-qualified worker image; got "${imageRef}"`,
    );
  }

  const image = createBlaxelWorkerImage(imageRef);
  return `${BLAXEL_WORKER_IMAGE_NAME_PREFIX}-${image.hash}-${WORKER_RUNTIME_SCHEMA_TAG}`;
}

/**
 * Imports the published Roomote worker image into Blaxel and injects Blaxel's
 * sandbox API. The temporary sandbox resource can be deleted after the build;
 * the returned immutable `sandbox/name:version` artifact remains available.
 */
export async function buildBlaxelWorkerImage(
  options: BuildBlaxelWorkerImageOptions,
): Promise<BuiltBlaxelWorkerImage> {
  const imageName =
    options.imageName ?? deriveBlaxelWorkerImageName(options.imageRef);
  const image = createBlaxelWorkerImage(options.imageRef);

  settings.setConfig({
    apiKey: options.apiKey,
    workspace: options.workspace,
  });

  console.log(
    `[buildBlaxelWorkerImage] Starting ${JSON.stringify({
      imageRef: options.imageRef,
      imageName,
      workspace: options.workspace,
    })}`,
  );

  try {
    const built = await image.build({
      name: imageName,
      memory: options.memoryMiB,
      timeout: options.timeoutMs,
      onStatusChange: options.onStatusChange,
    });
    const builtImageRef = built.spec.runtime?.image;

    if (!builtImageRef) {
      throw new Error(
        `Blaxel build "${imageName}" completed without an image reference`,
      );
    }

    console.log(
      `[buildBlaxelWorkerImage] Build complete ${JSON.stringify({
        imageName,
        imageRef: builtImageRef,
      })}`,
    );

    return { imageRef: builtImageRef, imageName };
  } finally {
    await SandboxInstance.delete(imageName).catch((error) => {
      console.warn(
        `[buildBlaxelWorkerImage] Failed to clean up build sandbox ${imageName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
