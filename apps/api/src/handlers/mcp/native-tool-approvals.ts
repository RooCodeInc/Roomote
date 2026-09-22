import {
  claimProxyTaskToolCall,
  describeProxyToolApprovalBlock,
  resolveProxyToolApprovalBlocks,
  type ProxyToolApprovalBlock,
} from './tool-approval-enforcement';
import {
  getJsonRpcMethod,
  getJsonRpcRequestId,
  getToolCallName,
  jsonRpcErrorResponse,
  resolveRunTokenTaskId,
  resolveTaskOrSessionUserIdOrNull,
  type McpAuthContext,
} from './proxy-utils';

interface NativeToolApprovalGuard {
  /** Refuse a call blocked by the same policy used by the proxy boundary. */
  checkCall(body: unknown): Promise<Response | null>;
  /** Hide disabled tools from a successful native tools/list response. */
  filterToolsList(body: unknown, response: Response): Promise<Response>;
}

const NOOP_GUARD: NativeToolApprovalGuard = {
  checkCall: async () => null,
  filterToolsList: async (_body, response) => response,
};

/** Read a native MCP request without consuming the body the transport needs. */
export async function readNativeMcpRequestBody(
  request: Request,
): Promise<unknown> {
  if (request.method !== 'POST') return undefined;

  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

/**
 * Native in-process MCP handlers do not pass through createMcpProxy, so they
 * need the same policy guard explicitly. Reject hides a tool from tools/list;
 * ask still appears for the model and is held until the Session owner decides.
 */
export async function resolveNativeToolApprovalGuard(input: {
  auth: McpAuthContext;
  integrationId: string;
}): Promise<NativeToolApprovalGuard> {
  const blocks = await resolveProxyToolApprovalBlocks({
    integrationId: input.integrationId,
    tokenType: input.auth.tokenType,
    resolveActingUserId: () => resolveTaskOrSessionUserIdOrNull(input.auth),
    resolveTaskId: () => resolveRunTokenTaskId(input.auth),
  });

  return blocks.size === 0 ? NOOP_GUARD : new NativeGuard(input, blocks);
}

class NativeGuard implements NativeToolApprovalGuard {
  constructor(
    private readonly input: { auth: McpAuthContext; integrationId: string },
    private readonly blocks: ReadonlyMap<string, ProxyToolApprovalBlock>,
  ) {}

  async checkCall(body: unknown): Promise<Response | null> {
    if (Array.isArray(body)) {
      return jsonRpcErrorResponse(
        400,
        -32600,
        'Batch JSON-RPC requests are not allowed on this endpoint',
      );
    }

    const toolName = getToolCallName(body);
    if (!toolName) return null;

    const block = this.blocks.get(toolName);
    if (!block) return null;

    if (block === 'needs_approval') {
      try {
        const approved = await claimProxyTaskToolCall({
          taskId: await resolveRunTokenTaskId(this.input.auth),
          integrationId: this.input.integrationId,
          toolName,
          args: (body as { params?: { arguments?: unknown } }).params
            ?.arguments,
        });
        if (approved) return null;
      } catch {
        // Fail closed when the approval cannot be read or consumed.
      }
    }

    return jsonRpcErrorResponse(
      403,
      -32000,
      describeProxyToolApprovalBlock(toolName, block),
      getJsonRpcRequestId(body),
    );
  }

  async filterToolsList(body: unknown, response: Response): Promise<Response> {
    if (
      getJsonRpcMethod(body) !== 'tools/list' ||
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    ) {
      return response;
    }

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }

    if (!payload || typeof payload !== 'object' || !('result' in payload)) {
      return response;
    }

    const result = (payload as { result?: unknown }).result;
    if (!result || typeof result !== 'object') return response;

    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return response;

    const visible = tools.filter(
      (tool) =>
        !(
          tool &&
          typeof tool === 'object' &&
          'name' in tool &&
          typeof tool.name === 'string' &&
          this.blocks.get(tool.name) === 'reject'
        ),
    );

    if (visible.length === tools.length) return response;

    return Response.json({
      ...payload,
      result: { ...(result as object), tools: visible },
    });
  }
}
