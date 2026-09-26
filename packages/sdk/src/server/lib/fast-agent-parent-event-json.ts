/** Remove code points PostgreSQL cannot store inside JSONB strings. */
export function sanitizeFastAgentParentEventJson<T>(value: T): T {
  return sanitize(value).value as T;
}

function sanitize(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const sanitized = value.replaceAll('\0', '');
    return { value: sanitized, changed: sanitized !== value };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = sanitize(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed
      ? { value: sanitized, changed: true }
      : { value, changed: false };
  }

  if (value !== null && typeof value === 'object') {
    let changed = false;
    const sanitizedEntries = Object.entries(value).map(([key, nestedValue]) => {
      const sanitizedKey = key.replaceAll('\0', '');
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
