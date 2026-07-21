import type { Job } from 'bullmq';

import { Env } from '@roomote/env';
import {
  validateDockerEnvironment,
  type DockerEnvironmentValidationResult,
} from '@roomote/compute-providers';

export interface DockerValidationJobData {
  /** Image resolved by the requesting web process; falls back to this process's env. */
  image?: string;
}

/**
 * Runs the Docker environment checks on behalf of the settings UI. This
 * process holds the Docker socket in self-host Docker deployments; the web
 * app does not, so it requests validation through this queue.
 */
export async function dockerValidationJob(
  job: Job<DockerValidationJobData, DockerEnvironmentValidationResult, string>,
): Promise<DockerEnvironmentValidationResult> {
  const image = job.data.image?.trim() || Env.DOCKER_WORKER_IMAGE;

  const result = await validateDockerEnvironment({
    image,
    ...(Env.DOCKER_WORKER_RELEASE_PATH
      ? { releaseArchivePath: Env.DOCKER_WORKER_RELEASE_PATH }
      : {}),
  });

  console.log(
    `[DockerValidationQueue] validated image=${image} ok=${result.ok} ${JSON.stringify(
      result.checks.map((check) => `${check.id}:${check.status}`),
    )}`,
  );

  return result;
}
