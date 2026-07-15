/**
 * Compatibility version for the tools and operating-system capabilities baked
 * into Roomote worker images. Bump this when an existing image tag or hosted
 * provider artifact must be rebuilt because the runtime contract changed.
 */
export const WORKER_RUNTIME_SCHEMA_VERSION = 4;

/** Stable string used in Docker labels and provider-side resource names. */
export const WORKER_RUNTIME_SCHEMA_TAG = `r${WORKER_RUNTIME_SCHEMA_VERSION}`;
