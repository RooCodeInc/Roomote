/**
 * Multiple OpenAI-compatible endpoint connections.
 *
 * The built-in catalog entry uses id `openai-compatible` with env vars
 * `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY`.
 *
 * Additional connections use ids `openai-compatible-<slug>` with env vars
 * `OPENAI_COMPATIBLE_<SLUG>_BASE_URL` / `OPENAI_COMPATIBLE_<SLUG>_API_KEY`
 * (and optional `OPENAI_COMPATIBLE_<SLUG>_LABEL` for display).
 */

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible' as const;

const OPENAI_COMPATIBLE_NAMED_ID_PREFIX = `${OPENAI_COMPATIBLE_PROVIDER_ID}-`;

/** Lowercase hyphenated connection slug used in provider ids. */
export const OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const OPENAI_COMPATIBLE_NAMED_ENV_SLUG_PATTERN =
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

const OPENAI_COMPATIBLE_BASE_URL_ENV_SUFFIX = '_BASE_URL';
const OPENAI_COMPATIBLE_API_KEY_ENV_SUFFIX = '_API_KEY';
const OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX = '_LABEL';
const OPENAI_COMPATIBLE_ENV_PREFIX = 'OPENAI_COMPATIBLE_';

export type OpenAiCompatibleProviderInstance = {
  id: string;
  slug: string | null;
  label: string;
  baseUrlEnvVarName: string;
  apiKeyEnvVarName: string;
  labelEnvVarName: string | null;
};

function slugToEnvSegment(slug: string): string {
  return slug.replaceAll('-', '_').toUpperCase();
}

function envSegmentToSlug(segment: string): string {
  return segment.toLowerCase().replaceAll('_', '-');
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Normalize a user-entered connection name into a stable slug, or null when
 * the value is empty or cannot form a valid id segment.
 */
export function normalizeOpenAiCompatibleConnectionSlug(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .replaceAll(/-{2,}/gu, '-');

  if (
    !normalized ||
    !OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(normalized)
  ) {
    return null;
  }

  // Keep the mismatch with the default id when someone types the built-in name.
  if (normalized === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return null;
  }

  if (normalized.startsWith(`${OPENAI_COMPATIBLE_PROVIDER_ID}-`)) {
    const withoutPrefix = normalized.slice(
      OPENAI_COMPATIBLE_PROVIDER_ID.length + 1,
    );
    return OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(withoutPrefix)
      ? withoutPrefix
      : null;
  }

  return normalized;
}

export function buildOpenAiCompatibleProviderId(slug: string | null): string {
  if (!slug) {
    return OPENAI_COMPATIBLE_PROVIDER_ID;
  }

  return `${OPENAI_COMPATIBLE_PROVIDER_ID}-${slug}`;
}

export function isOpenAiCompatibleProviderId(
  providerId: string | null | undefined,
): boolean {
  if (!providerId) {
    return false;
  }

  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return true;
  }

  if (!providerId.startsWith(OPENAI_COMPATIBLE_NAMED_ID_PREFIX)) {
    return false;
  }

  const slug = providerId.slice(OPENAI_COMPATIBLE_NAMED_ID_PREFIX.length);
  return OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(slug);
}

export function getOpenAiCompatibleProviderSlug(
  providerId: string,
): string | null {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return null;
  }

  if (!providerId.startsWith(OPENAI_COMPATIBLE_NAMED_ID_PREFIX)) {
    return null;
  }

  const slug = providerId.slice(OPENAI_COMPATIBLE_NAMED_ID_PREFIX.length);
  return OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(slug) ? slug : null;
}

export function buildOpenAiCompatibleProviderInstance(
  slug: string | null,
  options?: { label?: string | null },
): OpenAiCompatibleProviderInstance {
  if (!slug) {
    return {
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      slug: null,
      label: options?.label?.trim() || 'OpenAI-compatible',
      baseUrlEnvVarName: 'OPENAI_COMPATIBLE_BASE_URL',
      apiKeyEnvVarName: 'OPENAI_COMPATIBLE_API_KEY',
      labelEnvVarName: null,
    };
  }

  const envSegment = slugToEnvSegment(slug);
  const label = options?.label?.trim() || humanizeSlug(slug);

  return {
    id: buildOpenAiCompatibleProviderId(slug),
    slug,
    label: `OpenAI-compatible (${label})`,
    baseUrlEnvVarName: `${OPENAI_COMPATIBLE_ENV_PREFIX}${envSegment}${OPENAI_COMPATIBLE_BASE_URL_ENV_SUFFIX}`,
    apiKeyEnvVarName: `${OPENAI_COMPATIBLE_ENV_PREFIX}${envSegment}${OPENAI_COMPATIBLE_API_KEY_ENV_SUFFIX}`,
    labelEnvVarName: `${OPENAI_COMPATIBLE_ENV_PREFIX}${envSegment}${OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX}`,
  };
}

export function getOpenAiCompatibleProviderInstance(
  providerId: string,
  options?: { label?: string | null },
): OpenAiCompatibleProviderInstance | null {
  if (!isOpenAiCompatibleProviderId(providerId)) {
    return null;
  }

  return buildOpenAiCompatibleProviderInstance(
    getOpenAiCompatibleProviderSlug(providerId),
    options,
  );
}

/**
 * Parse a deployment env var name into an OpenAI-compatible instance when it
 * is a BASE_URL credential for either the default or a named connection.
 */
export function parseOpenAiCompatibleBaseUrlEnvVarName(
  envVarName: string,
): OpenAiCompatibleProviderInstance | null {
  if (envVarName === 'OPENAI_COMPATIBLE_BASE_URL') {
    return buildOpenAiCompatibleProviderInstance(null);
  }

  if (
    !envVarName.startsWith(OPENAI_COMPATIBLE_ENV_PREFIX) ||
    !envVarName.endsWith(OPENAI_COMPATIBLE_BASE_URL_ENV_SUFFIX)
  ) {
    return null;
  }

  const middle = envVarName.slice(
    OPENAI_COMPATIBLE_ENV_PREFIX.length,
    envVarName.length - OPENAI_COMPATIBLE_BASE_URL_ENV_SUFFIX.length,
  );

  if (!OPENAI_COMPATIBLE_NAMED_ENV_SLUG_PATTERN.test(middle)) {
    return null;
  }

  // Avoid treating OPENAI_COMPATIBLE_API_KEY as a base-url env by requiring
  // the middle segment (already needed for named env vars).
  const slug = envSegmentToSlug(middle);
  if (!OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(slug)) {
    return null;
  }

  return buildOpenAiCompatibleProviderInstance(slug);
}

export function listOpenAiCompatibleProviderInstancesFromEnvNames(
  envVarNames: Iterable<string>,
): OpenAiCompatibleProviderInstance[] {
  const byId = new Map<string, OpenAiCompatibleProviderInstance>();

  for (const name of envVarNames) {
    const instance = parseOpenAiCompatibleBaseUrlEnvVarName(name.trim());
    if (instance) {
      byId.set(instance.id, instance);
    }
  }

  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function getOpenAiCompatibleProviderEnvVarNames(
  providerId: string,
): string[] {
  const instance = getOpenAiCompatibleProviderInstance(providerId);
  if (!instance) {
    return [];
  }

  return [
    instance.baseUrlEnvVarName,
    instance.apiKeyEnvVarName,
    ...(instance.labelEnvVarName ? [instance.labelEnvVarName] : []),
  ];
}

export function isOpenAiCompatibleProviderEnvVarName(
  envVarName: string,
): boolean {
  if (
    envVarName === 'OPENAI_COMPATIBLE_BASE_URL' ||
    envVarName === 'OPENAI_COMPATIBLE_API_KEY'
  ) {
    return true;
  }

  if (!envVarName.startsWith(OPENAI_COMPATIBLE_ENV_PREFIX)) {
    return false;
  }

  const rest = envVarName.slice(OPENAI_COMPATIBLE_ENV_PREFIX.length);
  const baseUrl = parseOpenAiCompatibleBaseUrlEnvVarName(envVarName);
  if (baseUrl) {
    return true;
  }

  if (rest.endsWith(OPENAI_COMPATIBLE_API_KEY_ENV_SUFFIX)) {
    const middle = rest.slice(
      0,
      rest.length - OPENAI_COMPATIBLE_API_KEY_ENV_SUFFIX.length,
    );
    return (
      OPENAI_COMPATIBLE_NAMED_ENV_SLUG_PATTERN.test(middle) &&
      OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(envSegmentToSlug(middle))
    );
  }

  if (rest.endsWith(OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX)) {
    const middle = rest.slice(
      0,
      rest.length - OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX.length,
    );
    return (
      OPENAI_COMPATIBLE_NAMED_ENV_SLUG_PATTERN.test(middle) &&
      OPENAI_COMPATIBLE_CONNECTION_SLUG_PATTERN.test(envSegmentToSlug(middle))
    );
  }

  return false;
}
