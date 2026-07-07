/**
 * Generates a random task ID.
 * Uses 64 bits of cryptographic randomness encoded as base-36,
 * zero-padded to a fixed 13-character lowercase alphanumeric string.
 */
export function generateTaskId(): string {
  const array = new BigUint64Array(1);
  crypto.getRandomValues(array);
  return array[0]!.toString(36).padStart(13, '0');
}
