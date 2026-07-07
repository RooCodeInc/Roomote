import type { ComputeProvider } from '@roomote/types';

export class UnsupportedComputeProviderOperationError extends Error {
  public constructor(vendor: ComputeProvider, operation: string) {
    super(
      `[compute-providers] ${vendor} does not support operation: ${operation}`,
    );

    this.name = 'UnsupportedComputeProviderOperationError';
  }
}

export interface ModalRpcErrorMetadata {
  grpcStatus: string;
  modalErrorCode?: string;
  operation?: string;
  rpcMethod: string;
  rpcPath: string;
  rpcService: string;
}

export class ModalRpcError extends Error {
  public readonly metadata: ModalRpcErrorMetadata;

  public constructor(
    message: string,
    metadata: ModalRpcErrorMetadata,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModalRpcError';
    this.metadata = metadata;
  }
}

export function assertDefined<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

export function unsupported(vendor: ComputeProvider, op: string): never {
  throw new UnsupportedComputeProviderOperationError(vendor, op);
}
