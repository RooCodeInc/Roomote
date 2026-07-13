import type { ArtifactConfig, RoomoteConfig } from './types.js';

function normalizeApiBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function resolvePlatformApiUrl(): string {
  return normalizeApiBaseUrl(
    process.env.ROOMOTE_PLATFORM_API_URL ||
      process.env.R_TRPC_URL ||
      'http://localhost:13001',
  );
}

function resolveCloudToken(): string | null {
  return process.env.ROOMOTE_CLOUD_TOKEN || process.env.AUTH_TOKEN || null;
}

export function getArtifactConfig(): ArtifactConfig | null {
  const token = resolveCloudToken();
  if (!token) {
    return null;
  }

  return {
    token,
    platformApiUrl: resolvePlatformApiUrl(),
    workspacePath: process.env.ROOMOTE_WORKSPACE_PATH,
    authBypassHeaderName: process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
    authBypassHeaderValue: process.env.ROOMOTE_AUTH_BYPASS_VALUE,
  };
}

export function getRoomoteConfig(): RoomoteConfig | null {
  const token = resolveCloudToken();
  if (!token) {
    return null;
  }

  return {
    token,
    platformApiUrl: resolvePlatformApiUrl(),
    authBypassHeaderName: process.env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
    authBypassHeaderValue: process.env.ROOMOTE_AUTH_BYPASS_VALUE,
  };
}
