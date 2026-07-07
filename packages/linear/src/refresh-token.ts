const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function tokenNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) {
    return false;
  }

  return Date.now() >= tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS;
}

export async function refreshLinearToken(): Promise<never> {
  throw new Error(
    'refreshLinearToken is deprecated. Use the generic MCP token refresh path instead.',
  );
}

export async function getValidLinearAccessToken(): Promise<never> {
  throw new Error(
    'getValidLinearAccessToken is deprecated. Use the generic MCP token refresh path instead.',
  );
}
