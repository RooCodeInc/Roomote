import { z } from 'zod';

import type { NamedPort } from './environment-config';

export const SANDBOX_SERVER_PORT = 4200;

export const SANDBOX_SERVER_NAMED_PORT: NamedPort = {
  name: 'SANDBOX_SERVER',
  port: SANDBOX_SERVER_PORT,
};

/**
 * Legacy editor port identity retained so stale URLs remain classified as
 * system-managed. Roomote does not provide an editor service.
 */
export const CODE_SERVER_NAMED_PORT: NamedPort = {
  name: 'EDITOR',
  port: 0, // Dynamic -- resolved at runtime, routed through multiplex proxy
};

/**
 * Legacy browser-only surface kept only so mixed-state jobs continue to treat
 * stale GUI domains as internal/non-user-facing during rollout.
 */
export const LEGACY_SANDBOX_GUI_NAMED_PORT_NAME = 'GUI';

/**
 * Ports that require their own dedicated sandbox port slot. The legacy EDITOR
 * identity does not allocate a slot.
 */
export const INTERNAL_PORTS = new Set([SANDBOX_SERVER_NAMED_PORT.name]);

/**
 * Ports that are system-managed browser and runtime surfaces. Distinct from
 * INTERNAL_PORTS which controls sandbox port slot allocation.
 */
export const SYSTEM_PORT_NAMES = new Set([
  SANDBOX_SERVER_NAMED_PORT.name,
  CODE_SERVER_NAMED_PORT.name,
  LEGACY_SANDBOX_GUI_NAMED_PORT_NAME,
]);

export function mergeNamedPortsByName(...portSets: NamedPort[][]): NamedPort[] {
  const portsByName = new Map<string, NamedPort>();

  for (const portSet of portSets) {
    for (const port of portSet) {
      portsByName.set(port.name.toUpperCase(), {
        ...port,
        name: port.name.toUpperCase(),
      });
    }
  }

  return [...portsByName.values()];
}

/**
 * Prefix used by the worker's `StartupLogger.debug` channel. Lines starting
 * with this prefix are internal operational messages that should be hidden
 * from end users in the Startup UI but remain in raw sandbox logs for
 * developer inspection.
 */
export const STARTUP_DEBUG_PREFIX = '[debug]';

/**
 * Log line prefixes that should be hidden from the Startup UI.
 *
 * These are internal operational messages from the worker's setup pipeline
 * and service infrastructure. They remain in raw sandbox logs for developer
 * inspection via the `sandbox-logs` script or Vercel dashboard.
 */
export const STARTUP_HIDDEN_PREFIXES = [
  STARTUP_DEBUG_PREFIX,
  '[setup]',
  '[auth-proxy]',
  '[port-proxy]',
  '[multiplex-auth-proxy]',
] as const;

export const sandboxLogEventSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
});

export type SandboxLogEvent = z.infer<typeof sandboxLogEventSchema>;

export const sandboxErrorEventSchema = z.object({
  error: z.string(),
});

export type SandboxErrorEvent = z.infer<typeof sandboxErrorEventSchema>;

export interface SandboxLogEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}
