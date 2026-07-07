import { ModalRpcError } from '../errors';
import {
  buildModalRpcErrorEnrichment,
  normalizeModalRpcError,
  parseModalRpcErrorMetadata,
  resolveModalRpcErrorEnrichment,
} from './rpc-diagnostics';

describe('Modal RPC diagnostics', () => {
  describe('parseModalRpcErrorMetadata', () => {
    it.each([
      {
        expected: {
          grpcStatus: 'DEADLINE_EXCEEDED',
          operation: 'app_resolve',
          rpcMethod: 'AppGetOrCreate',
          rpcPath: '/modal.client.ModalClient/AppGetOrCreate',
          rpcService: 'modal.client.ModalClient',
        },
        message:
          '/modal.client.ModalClient/AppGetOrCreate UNAVAILABLE: Authorization check failed for app roomote-production; status = StatusCode.DEADLINE_EXCEEDED',
        name: 'prefers nested status codes when present',
        operation: 'app_resolve',
      },
      {
        expected: {
          grpcStatus: 'NOT_FOUND',
          modalErrorCode: '7KJF5ETD',
          operation: 'command_exec',
          rpcMethod: 'TaskExecStart',
          rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
          rpcService: 'modal.task_command_router.TaskCommandRouter',
        },
        message:
          '/modal.task_command_router.TaskCommandRouter/TaskExecStart NOT_FOUND: Modal Sandbox with container ID ta-01KT20Z4JR98XWKQNBNVSXWWNH not found. This means this Sandbox has already shut down. (Error code: 7KJF5ETD)',
        name: 'captures modal error codes from task router failures',
        operation: 'command_exec',
      },
      {
        expected: {
          grpcStatus: 'RESOURCE_EXHAUSTED',
          operation: 'secret_resolve',
          rpcMethod: 'SecretGetOrCreate',
          rpcPath: '/modal.client.ModalClient/SecretGetOrCreate',
          rpcService: 'modal.client.ModalClient',
        },
        message:
          '/modal.client.ModalClient/SecretGetOrCreate RESOURCE_EXHAUSTED: memory usage is too high',
        name: 'falls back to the top-level grpc status when no nested status exists',
        operation: 'secret_resolve',
      },
    ])('$name', ({ expected, message, operation }) => {
      expect(parseModalRpcErrorMetadata(new Error(message), operation)).toEqual(
        expected,
      );
    });

    it('returns undefined for non-Modal errors', () => {
      expect(
        parseModalRpcErrorMetadata(new Error('temporary lookup failure')),
      ).toBeUndefined();
      expect(parseModalRpcErrorMetadata('boom')).toBeUndefined();
    });
  });

  describe('normalizeModalRpcError', () => {
    it('wraps parsed Modal errors without changing the message', () => {
      const original = new Error(
        '/modal.task_command_router.TaskCommandRouter/TaskExecStart NOT_FOUND: Modal Sandbox with container ID ta-01KT20Z4JR98XWKQNBNVSXWWNH not found. This means this Sandbox has already shut down. (Error code: 7KJF5ETD)',
      );

      const normalized = normalizeModalRpcError(original, 'command_exec');

      expect(normalized).toBeInstanceOf(ModalRpcError);
      expect(normalized).toMatchObject({
        message: original.message,
        metadata: {
          grpcStatus: 'NOT_FOUND',
          modalErrorCode: '7KJF5ETD',
          operation: 'command_exec',
          rpcMethod: 'TaskExecStart',
          rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
          rpcService: 'modal.task_command_router.TaskCommandRouter',
        },
      });
      expect((normalized as ModalRpcError).cause).toBe(original);
    });

    it('returns existing Modal RPC errors unchanged', () => {
      const original = new ModalRpcError('already normalized', {
        grpcStatus: 'NOT_FOUND',
        rpcMethod: 'TaskExecStart',
        rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
        rpcService: 'modal.task_command_router.TaskCommandRouter',
      });

      expect(normalizeModalRpcError(original, 'command_exec')).toBe(original);
    });
  });

  describe('resolveModalRpcErrorEnrichment', () => {
    it('builds controller fingerprints and tags from shared metadata', () => {
      const error = new ModalRpcError('rpc failed', {
        grpcStatus: 'NOT_FOUND',
        modalErrorCode: '7KJF5ETD',
        operation: 'command_exec',
        rpcMethod: 'TaskExecStart',
        rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
        rpcService: 'modal.task_command_router.TaskCommandRouter',
      });

      expect(
        resolveModalRpcErrorEnrichment(error, {
          fingerprintPrefix: ['roomote-controller-exception'],
          phase: 'spawn_worker',
        }),
      ).toEqual({
        fingerprint: [
          'roomote-controller-exception',
          'provider:modal',
          'phase:spawn_worker',
          'operation:command_exec',
          'rpc:/modal.task_command_router.TaskCommandRouter/TaskExecStart',
          'grpc_status:NOT_FOUND',
        ],
        metadata: error.metadata,
        tags: {
          'roomote.grpc_status': 'NOT_FOUND',
          'roomote.modal_error_code': '7KJF5ETD',
          'roomote.modal_operation': 'command_exec',
          'roomote.modal_rpc_method': 'TaskExecStart',
          'roomote.modal_rpc_service':
            'modal.task_command_router.TaskCommandRouter',
        },
      });
    });

    it('fills unknown fingerprint segments when optional context is absent', () => {
      expect(
        buildModalRpcErrorEnrichment({
          grpcStatus: 'DEADLINE_EXCEEDED',
          rpcMethod: 'SandboxCreate',
          rpcPath: '/modal.client.ModalClient/SandboxCreate',
          rpcService: 'modal.client.ModalClient',
        }),
      ).toEqual({
        fingerprint: [
          'provider:modal',
          'phase:unknown',
          'operation:unknown',
          'rpc:/modal.client.ModalClient/SandboxCreate',
          'grpc_status:DEADLINE_EXCEEDED',
        ],
        metadata: {
          grpcStatus: 'DEADLINE_EXCEEDED',
          rpcMethod: 'SandboxCreate',
          rpcPath: '/modal.client.ModalClient/SandboxCreate',
          rpcService: 'modal.client.ModalClient',
        },
        tags: {
          'roomote.grpc_status': 'DEADLINE_EXCEEDED',
          'roomote.modal_rpc_method': 'SandboxCreate',
          'roomote.modal_rpc_service': 'modal.client.ModalClient',
        },
      });
    });
  });
});
