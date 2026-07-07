/**
 * Encodes an object as a URL-safe base64 string.
 * Browser-compatible implementation using btoa.
 * Note: Only supports Latin1 characters (ASCII subset).
 */
export function encodeRecord<T extends Record<string, unknown>>(
  data: T,
): string {
  return encodeURIComponent(btoa(JSON.stringify(data)));
}

/**
 * Decodes a URL-safe base64 string back to an object.
 * Browser-compatible implementation using atob.
 */
export function decodeRecord<T extends Record<string, unknown>>(
  encodedData: string,
): T | undefined {
  try {
    return JSON.parse(atob(decodeURIComponent(encodedData))) as T;
  } catch (_error) {
    return undefined;
  }
}
