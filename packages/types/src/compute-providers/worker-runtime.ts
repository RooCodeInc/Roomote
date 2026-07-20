/**
 * Shared sizing, timeout, and filesystem constants for the hosted worker
 * runtime contract. Historically named after Vercel Sandbox, which
 * originated the layout; the constants apply to every hosted provider.
 */

/** Default sandbox lifetime (ms). Used when no workflow-specific value applies. */
export const SANDBOX_TIMEOUT_MS = 5 * 60 * 60 * 1_000;

export const SANDBOX_DEFAULT_VCPUS = 8;

export const SANDBOX_MEMORY_MIB_PER_VCPU = 2_048;

export const SANDBOX_DEFAULT_MEMORY_MIB =
  SANDBOX_DEFAULT_VCPUS * SANDBOX_MEMORY_MIB_PER_VCPU;

/** Default memory for task sandboxes that do not run nested Docker. */
export const TASK_SANDBOX_DEFAULT_MEMORY_MIB = 4_096;

/** Default memory for task sandboxes that run nested Docker workloads. */
export const TASK_SANDBOX_DOCKER_MEMORY_MIB = 8_192;

export const SANDBOX_FILES_DIR = '/sandbox';

export const SANDBOX_SNAPSHOT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export const SNAPSHOT_JOB_RETRY_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
} as const;

/**
 * BullMQ queue for on-demand Docker environment validation requested from the
 * settings UI. Shared between the web producer and the bullmq consumer.
 */
export const DOCKER_VALIDATION_QUEUE_NAME = 'docker-validation-jobs';
