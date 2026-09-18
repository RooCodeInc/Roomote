/**
 * Decode bounded provider envelopes in breadth-first order. Display deliberately
 * follows only known envelope fields; classification also inspects arbitrary
 * enumerable values. Only content-filter detection reads native Error text.
 */
export function* decodeInferenceErrorEnvelope(
  error: unknown,
  policy: 'classification' | 'content-filter' | 'display',
): Generator<string | Record<string, unknown>> {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4) continue;
    const { value, depth } = current;
    if (typeof value === 'string') {
      yield value;
      if (policy !== 'display' || value.trim().startsWith('{')) {
        try {
          pending.push({ value: JSON.parse(value), depth: depth + 1 });
        } catch {
          // Plain provider prose has no nested envelope.
        }
      }
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    yield record;

    if (policy === 'display') {
      for (const key of [
        'providerError',
        'cause',
        'data',
        'error',
        'responseBody',
      ]) {
        if (key in record)
          pending.push({ value: record[key], depth: depth + 1 });
      }
    } else {
      if (policy === 'content-filter') {
        pending.push(
          { value: record.name, depth: depth + 1 },
          { value: record.message, depth: depth + 1 },
        );
      }
      for (const nested of Object.values(record)) {
        pending.push({ value: nested, depth: depth + 1 });
      }
    }
  }
}
