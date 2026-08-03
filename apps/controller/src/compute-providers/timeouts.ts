/**
 * Shared sandbox-provisioning deadlines for every compute provider.
 *
 * These were duplicated as literals in each spawn-*-worker module, so the
 * creation deadline could only be tuned five times or not at all.
 */

/**
 * How long to wait for a provider to hand back a running instance.
 *
 * Raised from three minutes after that deadline was observed manufacturing
 * false failures: under sandbox-creation rate limiting, creation routinely
 * outlasts three minutes, the run is marked `failed`, and then the sandbox
 * comes up anyway and the agent posts its work minutes later — leaving the
 * user an error banner on top of a finished task whose thread is dead
 * (roomote nightly, 2026-08-03: run failed at 3m00s, assistant output
 * arrived 12 minutes later; 4 of 42 failed runs that week did the same).
 *
 * Waiting longer is the cheaper mistake: a slow start still shows the
 * startup sequence, while a premature abort throws away real work.
 */
export const COMPUTE_CREATE_INSTANCE_TIMEOUT_MS = 10 * 60_000;

/**
 * How long to wait for a created instance to finish bootstrapping. Unchanged
 * — bootstrap runs after the provider has already given us the machine, so
 * it is not subject to the creation-queue contention above.
 */
export const COMPUTE_BOOTSTRAP_TIMEOUT_MS = 2 * 60_000;
