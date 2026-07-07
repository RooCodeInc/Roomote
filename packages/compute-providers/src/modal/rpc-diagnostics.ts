import { ModalRpcError, type ModalRpcErrorMetadata } from '../errors';

const MODAL_RPC_SIGNATURE_REGEX =
  /\/(?<service>modal\.[A-Za-z0-9_.]+)\/(?<method>[A-Za-z][A-Za-z0-9_]*)\s+(?<status>[A-Z_]+):/;
const MODAL_STATUS_CODE_REGEX = /status\s*=\s*StatusCode\.(?<status>[A-Z_]+)/;
const MODAL_ERROR_CODE_REGEX = /\(Error code:\s*(?<code>[A-Z0-9]+)\)/;

export interface ModalRpcErrorEnrichment {
  fingerprint: string[];
  metadata: ModalRpcErrorMetadata;
  tags: Record<string, string>;
}

export interface ModalRpcErrorEnrichmentOptions {
  fingerprintPrefix?: string[];
  phase?: string;
}

export function parseModalRpcErrorMetadata(
  error: unknown,
  operation?: string,
): ModalRpcErrorMetadata | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const rpcMatch = MODAL_RPC_SIGNATURE_REGEX.exec(error.message);

  if (!rpcMatch?.groups) {
    return undefined;
  }

  const rpcService = rpcMatch.groups.service;
  const rpcMethod = rpcMatch.groups.method;
  const fallbackGrpcStatus = rpcMatch.groups.status;

  if (!rpcService || !rpcMethod || !fallbackGrpcStatus) {
    return undefined;
  }

  const grpcStatus =
    MODAL_STATUS_CODE_REGEX.exec(error.message)?.groups?.status ??
    fallbackGrpcStatus;
  const modalErrorCode = MODAL_ERROR_CODE_REGEX.exec(error.message)?.groups
    ?.code;

  return {
    grpcStatus,
    ...(modalErrorCode ? { modalErrorCode } : {}),
    ...(operation ? { operation } : {}),
    rpcMethod,
    rpcPath: `/${rpcService}/${rpcMethod}`,
    rpcService,
  };
}

export function normalizeModalRpcError<TError>(
  error: TError,
  operation?: string,
): TError | ModalRpcError {
  if (error instanceof ModalRpcError) {
    return error;
  }

  const metadata = parseModalRpcErrorMetadata(error, operation);

  if (!(error instanceof Error) || !metadata) {
    return error;
  }

  return new ModalRpcError(error.message, metadata, {
    cause: error,
  });
}

export function getModalRpcErrorMetadata(
  error: unknown,
): ModalRpcErrorMetadata | undefined {
  return error instanceof ModalRpcError ? error.metadata : undefined;
}

export function buildModalRpcErrorEnrichment(
  metadata: ModalRpcErrorMetadata,
  options: ModalRpcErrorEnrichmentOptions = {},
): ModalRpcErrorEnrichment {
  return {
    metadata,
    fingerprint: [
      ...(options.fingerprintPrefix ?? []),
      'provider:modal',
      `phase:${options.phase ?? 'unknown'}`,
      `operation:${metadata.operation ?? 'unknown'}`,
      `rpc:${metadata.rpcPath}`,
      `grpc_status:${metadata.grpcStatus}`,
    ],
    tags: {
      'roomote.modal_rpc_service': metadata.rpcService,
      'roomote.modal_rpc_method': metadata.rpcMethod,
      'roomote.grpc_status': metadata.grpcStatus,
      ...(metadata.modalErrorCode
        ? { 'roomote.modal_error_code': metadata.modalErrorCode }
        : {}),
      ...(metadata.operation
        ? { 'roomote.modal_operation': metadata.operation }
        : {}),
    },
  };
}

export function resolveModalRpcErrorEnrichment(
  error: unknown,
  options: ModalRpcErrorEnrichmentOptions = {},
): ModalRpcErrorEnrichment | undefined {
  const metadata = getModalRpcErrorMetadata(error);

  return metadata ? buildModalRpcErrorEnrichment(metadata, options) : undefined;
}
