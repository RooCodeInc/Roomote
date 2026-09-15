import type { ComputeProvider } from './compute-provider';

/**
 * Declarative per-provider capability metadata. Lives in @roomote/types so
 * client code (e.g. startup-progress UI deciding whether live log streaming
 * exists) can read it without importing the provider SDKs bundled with
 * @roomote/compute-providers — those pull Node-only dependencies such as
 * gRPC into whatever bundle imports them.
 */
export interface ComputeProviderCapabilities {
  supportsCreateInstance: boolean;
  supportsDestroyInstance: boolean;
  supportsCommandExecution: boolean;
  supportsCommandOutputStreaming: boolean;
  supportsCommandOutputLookup: boolean;
  supportsSnapshots: boolean;
  /** Can retain and later reconnect to the same suspended instance. */
  supportsStandbyResume: boolean;
  supportsResume: boolean;
  supportsFileWrite: boolean;
  /** Can run customer-owned Docker Compose and Dockerfile projects. */
  supportsDockerProjects: boolean;
  /**
   * How the provider can hold a Session-egress workload.
   *
   * - `api_proxy`: the workload receives substitutes and calls the API-side
   *   substitution proxy over the route it already uses for the API;
   *   possession of the substitute is the authority, bounded by the live
   *   workload, run, Session, and grant state.
   * - `unsupported`: fails closed; no workload is registered and no
   *   substitute is ever delivered.
   */
  credentialEgress: ComputeProviderCredentialEgressCapability;
}

export type ComputeProviderCredentialEgressCapability =
  | 'api_proxy'
  | 'unsupported';

export type ComputeProviderCommandOutputSource =
  | 'central'
  | 'provider'
  | 'none';

export const DOCKER_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: false,
  supportsDestroyInstance: false,
  supportsCommandExecution: false,
  supportsCommandOutputStreaming: false,
  supportsCommandOutputLookup: false,
  supportsSnapshots: false,
  supportsStandbyResume: true,
  supportsResume: true,
  supportsFileWrite: false,
  supportsDockerProjects: true,
  // The worker reaches the API over the task network; substitutes are used
  // through the API-side credential egress proxy like every other provider.
  credentialEgress: 'api_proxy',
};

export const MODAL_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  supportsCommandOutputStreaming: false,
  supportsCommandOutputLookup: false,
  supportsSnapshots: true,
  supportsStandbyResume: false,
  supportsResume: true,
  supportsFileWrite: true,
  supportsDockerProjects: true,
  // Sandboxes reach the API over HTTPS already; substitutes are used through
  // the API-side credential egress proxy, so no connector is needed.
  credentialEgress: 'api_proxy',
};

export const DAYTONA_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  supportsCommandOutputStreaming: true,
  supportsCommandOutputLookup: true,
  supportsSnapshots: true,
  supportsStandbyResume: false,
  supportsResume: true,
  supportsFileWrite: true,
  supportsDockerProjects: true,
  // Substitutes are used through the API-side credential egress proxy; see
  // MODAL_CAPABILITIES.
  credentialEgress: 'api_proxy',
};

export const E2B_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  supportsCommandOutputStreaming: true,
  supportsCommandOutputLookup: true,
  supportsSnapshots: true,
  supportsStandbyResume: false,
  supportsResume: true,
  supportsFileWrite: true,
  supportsDockerProjects: true,
  // Substitutes are used through the API-side credential egress proxy; see
  // MODAL_CAPABILITIES.
  credentialEgress: 'api_proxy',
};

export const BLAXEL_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  supportsCommandOutputStreaming: true,
  supportsCommandOutputLookup: true,
  supportsSnapshots: false,
  supportsStandbyResume: true,
  supportsResume: true,
  supportsFileWrite: true,
  supportsDockerProjects: true,
  // Substitutes are used through the API-side credential egress proxy; see
  // MODAL_CAPABILITIES.
  credentialEgress: 'api_proxy',
};

export const BOX_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  supportsCommandOutputStreaming: true,
  supportsCommandOutputLookup: true,
  // Named snapshots (template boxes): fork-on-deploy via POST /boxes {from}.
  supportsSnapshots: true,
  supportsStandbyResume: true,
  supportsResume: true,
  supportsFileWrite: true,
  supportsDockerProjects: true,
  // Substitutes are used through the API-side credential egress proxy; see
  // MODAL_CAPABILITIES.
  credentialEgress: 'api_proxy',
};

export const AZURE_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: true,
  supportsDestroyInstance: true,
  supportsCommandExecution: true,
  // Poll-based streaming over detached-command log files.
  supportsCommandOutputStreaming: true,
  supportsCommandOutputLookup: true,
  supportsSnapshots: true,
  // ACA suspend/resume preserves full memory+disk with sub-second restore.
  supportsStandbyResume: true,
  supportsResume: true,
  supportsFileWrite: true,
  // dockerd runs inside the ACA microVM (verified against the worker image).
  supportsDockerProjects: true,
  // Substitutes are used through the API-side credential egress proxy; see
  // MODAL_CAPABILITIES.
  credentialEgress: 'api_proxy',
};

export function getComputeProviderCapabilities(
  provider: ComputeProvider,
): ComputeProviderCapabilities {
  switch (provider) {
    // Roomote Cloud runs on deployment-managed Modal infrastructure, so its
    // runtime capabilities are Modal's.
    case 'modal':
    case 'roomote':
      return MODAL_CAPABILITIES;
    case 'docker':
      return DOCKER_CAPABILITIES;
    case 'daytona':
      return DAYTONA_CAPABILITIES;
    case 'e2b':
      return E2B_CAPABILITIES;
    case 'blaxel':
      return BLAXEL_CAPABILITIES;
    case 'box':
      return BOX_CAPABILITIES;
    case 'azure':
      return AZURE_CAPABILITIES;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

export function getComputeProviderCommandOutputSource(
  provider: ComputeProvider,
): ComputeProviderCommandOutputSource {
  if (provider === 'roomote') return 'central';

  return getComputeProviderCapabilities(provider).supportsCommandOutputLookup
    ? 'provider'
    : 'none';
}

/**
 * Session-egress gate. Providers whose sandboxes can reach the API-side proxy
 * receive substitute tokens; any other provider fails closed with an explicit
 * status.
 */
export function getComputeProviderCredentialEgressCapability(
  provider: ComputeProvider,
): ComputeProviderCredentialEgressCapability {
  return getComputeProviderCapabilities(provider).credentialEgress;
}
