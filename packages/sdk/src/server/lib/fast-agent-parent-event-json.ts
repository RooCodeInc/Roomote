/** JSON values persisted in Fast parent-event JSONB payloads. */
type FastAgentParentEventJsonValue =
  | null
  | boolean
  | number
  | string
  | FastAgentParentEventJsonValue[]
  | { [key: string]: FastAgentParentEventJsonValue | undefined };

/**
 * Remove code points PostgreSQL cannot store inside JSONB strings.
 *
 * A changed object is rebuilt, so callers must not rely on its identity. If
 * two keys collapse after NUL removal, sanitization rejects the value instead
 * of silently dropping one of the properties.
 */
export function sanitizeFastAgentParentEventJson(
  value: FastAgentParentEventJsonValue,
): FastAgentParentEventJsonValue {
  return sanitize(value).value as FastAgentParentEventJsonValue;
}

function sanitize(value: FastAgentParentEventJsonValue | undefined): {
  value: FastAgentParentEventJsonValue | undefined;
  changed: boolean;
} {
  if (typeof value === 'string') {
    const sanitized = value.replaceAll('\0', '');
    return { value: sanitized, changed: sanitized !== value };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = sanitize(item);
      changed ||= result.changed;
      return result.value as FastAgentParentEventJsonValue;
    });
    return changed
      ? { value: sanitized, changed: true }
      : { value, changed: false };
  }

  if (value !== null && typeof value === 'object') {
    let changed = false;
    const sanitizedKeys = new Set<string>();
    const sanitizedEntries = Object.entries(value).map(([key, nestedValue]) => {
      const sanitizedKey = key.replaceAll('\0', '');
      if (sanitizedKeys.has(sanitizedKey)) {
        throw new Error(
          'Fast parent event JSON keys collide after NUL sanitization.',
        );
      }
      sanitizedKeys.add(sanitizedKey);
      const result = sanitize(nestedValue);
      changed ||= sanitizedKey !== key || result.changed;
      return [sanitizedKey, result.value] as const;
    });
    return changed
      ? { value: Object.fromEntries(sanitizedEntries), changed: true }
      : { value, changed: false };
  }

  return { value, changed: false };
}
