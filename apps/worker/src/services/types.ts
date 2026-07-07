import { CommandExecutor } from '../command-executor';

/**
 * Context passed to services that require auth-proxy configuration.
 * Used by the multiplex port-proxy and related preview services.
 * Built from WorkerEnv values (not process.env) to ensure correct key pairing.
 */
export interface ServiceContext {
  /** Cloud job ID for direct preview-token binding. */
  cloudJobId?: number;
  /** Task ID for this worker - used for logging/diagnostics. */
  taskId?: string;
  /**
   * ES256 public key for JWT validation (base64 encoded).
   */
  publicKey?: string;
  /**
   * Root directory for the workspace (where repositories are cloned).
   */
  workspaceRoot?: string;
  /**
   * Proxy port mapping for named ports.
   * Maps port name (e.g., 'MY_APP') to proxy port (e.g., 50001).
   * Used to start port proxies that forward to app ports.
   */
  proxyPorts?: Record<string, number>;
  /**
   * App port mapping for named ports.
   * Maps port name (e.g., 'MY_APP') to app port (e.g., 3000).
   */
  appPorts?: Record<string, number>;
  /**
   * Set of port names that should skip authentication.
   */
  unauthenticatedPorts?: Set<string>;
  /**
   * Subdomain mapping for named ports.
   */
  subdomains?: Record<string, string>;
  /**
   * Explicit primary port name from the cloud job, computed at write time.
   */
  primaryPortName?: string | null;
  /**
   * Set of port names that have wildcard prefix routing enabled.
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
}

export interface ServiceDefinition {
  defaultPort: number;
  install: (executor: CommandExecutor) => Promise<void>;
  start: (
    executor: CommandExecutor,
    port: number,
    context?: ServiceContext,
  ) => Promise<void>;
  healthCheck: (port: number) => Promise<boolean>;
  /**
   * Confirms that the running service instance on the requested port is the
   * one managed by Roomote, not an unrelated process that happens to be
   * healthy.
   */
  verifyManagedInstance?: (port: number) => Promise<boolean>;
  getConnectionInfo: (port: number) => {
    connectionString: string;
    envVars: Record<string, string>;
  };
}
