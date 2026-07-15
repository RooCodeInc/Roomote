/**
 * Backend engines that can power the deployment-managed `roomote` compute
 * provider. The provider's contract is engine-neutral — deployment-managed
 * credentials (`ROOMOTE_CLOUD_TOKEN_ID` / `ROOMOTE_CLOUD_TOKEN_SECRET`) and
 * persisted vendor `roomote` — while `ROOMOTE_CLOUD_BACKEND` selects which
 * engine actually runs the sandboxes.
 *
 * Only the Modal backend exists today. Adding an engine means extending this
 * list and the two dispatch sites that branch on the resolved backend: the
 * compute-provider factory (client construction) and the controller's spawn
 * switch — plus making the static per-provider metadata (capabilities,
 * worker label, resource model, usage policy) backend-aware.
 *
 * Note: the backend is a per-deployment choice. Switching it on a live
 * deployment requires draining `roomote`-vendor task runs and dropping
 * environment snapshots first — machine ids and snapshots are
 * engine-specific.
 */
export const ROOMOTE_CLOUD_BACKENDS = ['modal'] as const;

export type RoomoteCloudBackend = (typeof ROOMOTE_CLOUD_BACKENDS)[number];

export const DEFAULT_ROOMOTE_CLOUD_BACKEND: RoomoteCloudBackend = 'modal';

export const ROOMOTE_CLOUD_BACKEND_ENV_VAR = 'ROOMOTE_CLOUD_BACKEND';

/**
 * Engine-neutral deployment identity for the managed provider. Backends map
 * it to their native grouping mechanism — the Modal backend groups the
 * deployment's sandboxes under the app `roomote-<slug>` — so hosting
 * operators get per-deployment usage attribution without touching
 * engine-specific env vars (which would also affect an operator's
 * bring-your-own provider of the same engine).
 */
export const ROOMOTE_CLOUD_SLUG_ENV_VAR = 'ROOMOTE_CLOUD_SLUG';

export function resolveRoomoteCloudSlug(
  env: Partial<Record<string, string | undefined>>,
): string | null {
  return env[ROOMOTE_CLOUD_SLUG_ENV_VAR]?.trim() || null;
}

/**
 * Modal app name for the managed provider's Modal backend. An explicit
 * `MODAL_APP_NAME` wins as an escape hatch; otherwise the deployment slug
 * maps to `roomote-<slug>`; with neither, the Modal client's default
 * applies.
 */
export function resolveRoomoteCloudModalAppName(
  env: Partial<Record<string, string | undefined>>,
): string | undefined {
  const explicit = env.MODAL_APP_NAME?.trim();

  if (explicit) {
    return explicit;
  }

  const slug = resolveRoomoteCloudSlug(env);

  return slug ? `roomote-${slug}` : undefined;
}

export function isRoomoteCloudBackend(
  value: string,
): value is RoomoteCloudBackend {
  return ROOMOTE_CLOUD_BACKENDS.includes(value as RoomoteCloudBackend);
}

/**
 * Resolves the managed provider's backend engine from the deployment env,
 * defaulting to Modal. Throws on an unsupported value: a misconfigured
 * backend must fail loudly at spawn/client construction rather than silently
 * running on the wrong engine.
 */
export function resolveRoomoteCloudBackend(
  env: Partial<Record<string, string | undefined>>,
): RoomoteCloudBackend {
  const value = env[ROOMOTE_CLOUD_BACKEND_ENV_VAR]?.trim();

  if (!value) {
    return DEFAULT_ROOMOTE_CLOUD_BACKEND;
  }

  if (!isRoomoteCloudBackend(value)) {
    throw new Error(
      `Unsupported ${ROOMOTE_CLOUD_BACKEND_ENV_VAR} "${value}"; supported backends: ${ROOMOTE_CLOUD_BACKENDS.join(', ')}`,
    );
  }

  return value;
}
