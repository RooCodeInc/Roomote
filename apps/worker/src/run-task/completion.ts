import { resolveKeepaliveMs, type TaskPayloadKind } from '@roomote/types';

/**
 * Worker-side wrapper over the shared keepalive policy resolver.
 * Legacy jobs that do not have a persisted keepalive still use this fallback
 * path.
 */
export function getDefaultKeepaliveMs(options: {
  taskType?: TaskPayloadKind | null;
  appEnv?: 'development' | 'preview' | 'production' | 'test' | null;
  defaultKeepaliveMs: number;
  delegatedKeepaliveMs: number;
  sandboxTimeoutMs: number;
}): number {
  return resolveKeepaliveMs(options);
}
