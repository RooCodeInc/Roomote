import type http from 'node:http';

import { captureWorkerException } from '../monitoring/sentry';

import { startMultiplexAuthProxy } from './auth-proxy';

/**
 * Start a multiplexing port proxy for named ports.
 *
 * All proxied ports share a single exposed port (multiplex port). The proxy
 * routes requests to the correct target port based on the x-roomote-forwarded-host
 * header, which contains the original hostname with the port name embedded.
 *
 * Authentication is validated via JWT tokens. Requests without a valid
 * preview_auth cookie receive 401 from the auth proxy.
 * Ports marked as unauthenticated skip auth validation.
 */
export async function startPortProxies(config: {
  /**
   * Port name (e.g., 'MY_APP') -> proxy port (e.g., 50001) mapping.
   * With multiplexing, all proxied ports share the same proxy port value.
   */
  proxyPorts: Record<string, number>;
  /** Port name (e.g., 'MY_APP') -> app port (e.g., 3000) mapping */
  appPorts: Record<string, number>;
  /** Task ID for logging/diagnostics */
  taskId: string;
  /** ES256 public key for JWT validation - base64 encoded */
  publicKey: string;
  /**
   * Set of port names that should skip authentication entirely.
   */
  unauthenticatedPorts?: Set<string>;
  /**
   * Per-port Host header rewrites for upstream apps that route on subdomain.
   */
  subdomains?: Record<string, string>;
  /**
   * Ports that accept nested preview-proxy prefixes.
   */
  wildcardPrefixPorts?: Set<string>;
  /**
   * Name of the auth cookie. Defaults to 'preview_auth'.
   * Configurable for nested proxy support where inner proxies use a different cookie name.
   */
  authCookieName?: string;
  /**
   * Per-port path prefixes that bypass authentication.
   */
  authBypassPaths?: Record<string, string[]>;
  /**
   * Value for the auth bypass header. When set, requests with this value
   * in the bypass header skip authentication entirely.
   */
  authBypassHeaderValue?: string;
  /**
   * Custom header name for the auth bypass mechanism.
   * Defaults to 'x-bypass-roomote-auth' when not set.
   */
  authBypassHeaderName?: string;
}): Promise<{
  /** All running proxy servers */
  servers: http.Server[];
  /** Stop all proxy servers */
  stop: () => Promise<void>;
}> {
  const {
    proxyPorts,
    appPorts,
    taskId,
    publicKey,
    unauthenticatedPorts,
    subdomains,
    wildcardPrefixPorts,
    authCookieName,
    authBypassPaths,
    authBypassHeaderValue,
    authBypassHeaderName,
  } = config;

  // Find the multiplex port (all proxied ports share the same value).
  const proxyPortValues = new Set(Object.values(proxyPorts));

  if (proxyPortValues.size === 0) {
    console.log('[port-proxy] No proxied ports configured, nothing to start');
    return { servers: [], stop: async () => {} };
  }

  if (proxyPortValues.size > 1) {
    // This shouldn't happen with multiplexing, but handle gracefully.
    console.warn(
      `[port-proxy] Multiple proxy ports found (${[...proxyPortValues].join(', ')}), expected single multiplex port`,
    );
  }

  const multiplexPort = [...proxyPortValues][0]!;

  // Build port mapping: port name -> app port.
  const portMapping: Record<string, number> = {};

  for (const [portName, proxyPort] of Object.entries(proxyPorts)) {
    // Only include ports that map to the multiplex port.
    if (proxyPort === multiplexPort) {
      const appPort = appPorts[portName];

      if (appPort !== undefined) {
        portMapping[portName] = appPort;
      } else {
        console.warn(
          `[port-proxy] No app port found for ${portName}, skipping`,
        );
      }
    }
  }

  if (Object.keys(portMapping).length === 0) {
    console.log('[port-proxy] No valid port mappings, nothing to start');
    return { servers: [], stop: async () => {} };
  }

  const portNames = Object.keys(portMapping);

  console.log(
    `[port-proxy] Starting multiplex proxy on :${multiplexPort} for ports: ${portNames.join(', ')}`,
  );

  try {
    const server = await startMultiplexAuthProxy({
      listenPort: multiplexPort,
      portMapping,
      publicKey,
      taskId,
      unauthenticatedPorts,
      subdomains,
      wildcardPrefixPorts,
      authCookieName,
      authBypassPaths,
      authBypassHeaderValue,
      authBypassHeaderName,
    });

    return {
      servers: [server],
      stop: async () => {
        console.log('[port-proxy] Stopping multiplex port proxy');

        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      },
    };
  } catch (error) {
    captureWorkerException(error, { stage: 'startPortProxies', taskId });

    console.error(
      `[port-proxy] Failed to start multiplex proxy: ${error instanceof Error ? error.message : String(error)}`,
    );

    return { servers: [], stop: async () => {} };
  }
}
