import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateClientUuid } from '../client-uuid';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateClientUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when available', () => {
    expect(generateClientUuid()).toMatch(UUID_V4_PATTERN);
  });

  it('falls back to a v4 UUID when randomUUID is missing (insecure origins)', () => {
    const getRandomValues =
      globalThis.crypto.getRandomValues.bind(globalThis.crypto);

    vi.stubGlobal('crypto', { getRandomValues });

    expect(generateClientUuid()).toMatch(UUID_V4_PATTERN);
  });

  it('generates unique values without randomUUID', () => {
    const getRandomValues =
      globalThis.crypto.getRandomValues.bind(globalThis.crypto);

    vi.stubGlobal('crypto', { getRandomValues });

    const seen = new Set(
      Array.from({ length: 100 }, () => generateClientUuid()),
    );

    expect(seen.size).toBe(100);
  });
});
