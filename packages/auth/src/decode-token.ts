import jwt from 'jsonwebtoken';

export function decodeTokenPayload(
  token: string,
): Record<string, unknown> | null {
  const decoded = jwt.decode(token);

  return decoded && typeof decoded === 'object'
    ? (decoded as Record<string, unknown>)
    : null;
}

export function getDecodedTokenType(token: string): string | undefined {
  const rawRouting = decodeTokenPayload(token)?.r;

  if (!rawRouting || typeof rawRouting !== 'object') {
    return undefined;
  }

  const tokenType = (rawRouting as Record<string, unknown>).t;
  return typeof tokenType === 'string' ? tokenType : undefined;
}
