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
}

export const DOCKER_CAPABILITIES: ComputeProviderCapabilities = {
  supportsCreateInstance: false,
  supportsDestroyInstance: false,
  supportsCommandExecution: false,
  supportsCommandOutputStreaming: false,
  supportsCommandOutputLookup: false,
  supportsSnapshots: false,
  supportsStandbyResume: false,
  supportsResume: false,
  supportsFileWrite: false,
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
};

export function getComputeProviderCapabilities(
  provider: ComputeProvider,
): ComputeProviderCapabilities {
  switch (provider) {
    case 'modal':
      return MODAL_CAPABILITIES;
    case 'docker':
      return DOCKER_CAPABILITIES;
    case 'daytona':
      return DAYTONA_CAPABILITIES;
    case 'e2b':
      return E2B_CAPABILITIES;
    case 'blaxel':
      return BLAXEL_CAPABILITIES;
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}
