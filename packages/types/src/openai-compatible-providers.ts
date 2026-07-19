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

/** Max characters accepted for a user-entered connection name before normalize. */
export const OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH = 64;

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
 * Linear validation for lowercase hyphenated slugs. Avoids backtracking-prone
 * regular expressions so request validation stays O(n).
 */
export function isOpenAiCompatibleConnectionSlug(slug: string): boolean {
  if (
    slug.length === 0 ||
    slug.length > OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH
  ) {
    return false;
  }

  const first = slug.charCodeAt(0);
  if (first < 97 || first > 122) {
    return false;
  }

  let previousWasHyphen = false;
  for (let index = 0; index < slug.length; index += 1) {
    const code = slug.charCodeAt(index);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isHyphen = code === 45;

    if (!(isLower || isDigit || isHyphen)) {
      return false;
    }

    if (isHyphen) {
      if (previousWasHyphen || index === slug.length - 1) {
        return false;
      }
      previousWasHyphen = true;
      continue;
    }

    previousWasHyphen = false;
  }

  return true;
}

/**
 * Linear validation for UPPER_SNAKE env-name middle segments.
 */
function isOpenAiCompatibleNamedEnvSlug(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment.length > OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH
  ) {
    return false;
  }

  const first = segment.charCodeAt(0);
  if (first < 65 || first > 90) {
    return false;
  }

  let previousWasUnderscore = false;
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    const isUnderscore = code === 95;

    if (!(isUpper || isDigit || isUnderscore)) {
      return false;
    }

    if (isUnderscore) {
      if (previousWasUnderscore || index === segment.length - 1) {
        return false;
      }
      previousWasUnderscore = true;
      continue;
    }

    previousWasUnderscore = false;
  }

  return true;
}

/**
 * Normalize a user-entered connection name into a stable slug, or null when
 * the value is empty or cannot form a valid id segment.
 *
 * Intentionally uses a linear character scan (no global regex) so pathological
 * hyphen/underscore sequences cannot turn request validation quadratic.
 */
export function normalizeOpenAiCompatibleConnectionSlug(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH
  ) {
    return null;
  }

  let normalized = '';
  let lastWasHyphen = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    const lowerCode = code >= 65 && code <= 90 ? code + 32 : code;
    const isLower = lowerCode >= 97 && lowerCode <= 122;
    const isDigit = lowerCode >= 48 && lowerCode <= 57;

    if (isLower || isDigit) {
      normalized += String.fromCharCode(lowerCode);
      lastWasHyphen = false;
      continue;
    }

    // Collapse any non-alphanumeric run into a single hyphen once content has
    // started.
    if (normalized.length > 0 && !lastWasHyphen) {
      normalized += '-';
      lastWasHyphen = true;
    }
  }

  if (lastWasHyphen) {
    normalized = normalized.slice(0, -1);
  }

  if (!isOpenAiCompatibleConnectionSlug(normalized)) {
    return null;
  }

  // Keep the mismatch with the default id when someone types the built-in name.
  if (normalized === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return null;
  }

  if (normalized.startsWith(OPENAI_COMPATIBLE_NAMED_ID_PREFIX)) {
    const withoutPrefix = normalized.slice(
      OPENAI_COMPATIBLE_NAMED_ID_PREFIX.length,
    );
    return isOpenAiCompatibleConnectionSlug(withoutPrefix)
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
  return isOpenAiCompatibleConnectionSlug(slug);
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
  return isOpenAiCompatibleConnectionSlug(slug) ? slug : null;
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

  if (!isOpenAiCompatibleNamedEnvSlug(middle)) {
    return null;
  }

  // Avoid treating OPENAI_COMPATIBLE_API_KEY as a base-url env by requiring
  // the middle segment (already needed for named env vars).
  const slug = envSegmentToSlug(middle);
  if (!isOpenAiCompatibleConnectionSlug(slug)) {
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
      isOpenAiCompatibleNamedEnvSlug(middle) &&
      isOpenAiCompatibleConnectionSlug(envSegmentToSlug(middle))
    );
  }

  if (rest.endsWith(OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX)) {
    const middle = rest.slice(
      0,
      rest.length - OPENAI_COMPATIBLE_LABEL_ENV_SUFFIX.length,
    );
    return (
      isOpenAiCompatibleNamedEnvSlug(middle) &&
      isOpenAiCompatibleConnectionSlug(envSegmentToSlug(middle))
    );
  }

  return false;
}
