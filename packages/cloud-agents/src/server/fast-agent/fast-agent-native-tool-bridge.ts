import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  ROOMOTE_TASK_INSPECTION_ACTIONS,
} from '@roomote/types';
import { z } from 'zod';

import { ROOMOTE_OPENCODE_SPILL_ANALYSIS_AGENT_NAME } from '../../opencode-prompt-subagents';

import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  isFastAgentSpillSubagentTool,
  type FastAgentNativeToolName,
} from './fast-agent-tool-policy';
import { fastAgentSpillStore } from './fast-agent-spill-store';

export {
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_SPILL_SUBAGENT_TOOL_FILTER,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
} from './fast-agent-tool-policy';
export type { FastAgentNativeToolName } from './fast-agent-tool-policy';

const FAST_AGENT_TOOL_BRIDGE_BODY_LIMIT_BYTES = 1_000_000;
const FAST_AGENT_TOOL_BRIDGE_ERROR = 'Fast tool execution failed.';
export const FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES = 40_000;
const FAST_AGENT_NATIVE_TOOL_PREVIEW_LIMIT_BYTES = 8_000;

export type FastAgentNativeToolCall = {
  agent?: string;
  name: FastAgentNativeToolName;
  args: Record<string, unknown>;
};

type FastAgentNativeToolExecutor = (
  call: FastAgentNativeToolCall,
) => Promise<unknown>;

type FastAgentNativeToolRuntime = {
  directory: string;
  env: Record<string, string>;
};

type ActiveExecutor = {
  conversationId: string;
  executor: FastAgentNativeToolExecutor;
};

type FastAgentBridgeOutput = {
  metadata: Record<string, unknown>;
  output: string;
};

const bridgeRequestSchema = z.object({
  sessionID: z.string().min(1),
  tool: z.enum(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES) as [
      FastAgentNativeToolName,
      ...FastAgentNativeToolName[],
    ],
  ),
  args: z.record(z.unknown()),
  agent: z.string().min(1).optional(),
});

const spillReadArgsSchema = z.object({
  handle: z.string().min(1),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

const spillGrepArgsSchema = z.object({
  handle: z.string().min(1),
  maxMatches: z.number().int().positive().optional(),
  query: z.string().min(1),
});

const FAST_AGENT_NATIVE_TOOL_BRIDGE_SOURCE = String.raw`
export const invoke = async (name, args, context) => {
  const url = process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL
  const token = process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN
  if (!url || !token) throw new Error("Roomote Fast tool bridge is unavailable.")

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionID: context.sessionID, agent: context.agent, tool: name, args }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || "Roomote Fast tool " + name + " failed.")
  }
  return {
    title: name,
    output: payload.output,
    metadata: payload.metadata ?? {},
  }
}
`;

const FAST_AGENT_NATIVE_TOOL_SOURCES: Record<FastAgentNativeToolName, string> =
  {
    [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Post a user-visible reply in the current Slack or Discord conversation.",
  args: {
    message: z.string().min(1).describe("Markdown reply text"),
    purpose: z.enum(["ack", "progress", "closeout", "clarification"]),
    imageArtifactIds: z.array(z.string()).optional(),
  },
  execute: (args, context) => invoke("send_chat_reply", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReaction]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Add a Slack emoji reaction to the current incoming message.",
  args: {
    name: z.string().min(1).describe("Slack emoji name without colons"),
    purpose: z.enum(["ack", "closeout"]),
  },
  execute: (args, context) => invoke("send_chat_reaction", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.getChatMessageContext]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: ${JSON.stringify(`${CHAT_MESSAGE_CONTEXT_TOOL.description} Fast mode restricts this lookup to the current conversation channel.`)},
  args: {
    messageId: z.string().min(1).describe("Provider message ID or timestamp in the current conversation channel."),
  },
  execute: (args, context) => invoke(${JSON.stringify(CHAT_MESSAGE_CONTEXT_TOOL.name)}, args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.getChatChannelMessages]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: ${JSON.stringify(`${CHAT_CHANNEL_MESSAGES_TOOL.description} Fast mode restricts this lookup to the current conversation channel and defaults Slack history to the previous 24 hours when oldest is omitted.`)},
  args: {
    oldest: z.string().min(1).optional().describe(${JSON.stringify(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.oldest)}),
    latest: z.string().min(1).optional().describe(${JSON.stringify(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.latest)}),
  },
  execute: (args, context) => invoke(${JSON.stringify(CHAT_CHANNEL_MESSAGES_TOOL.name)}, args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.launchTask]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Delegate new repository or workspace execution work to a Roomote task, optionally using an exact deployment-enabled model ID from the system prompt.",
  args: {
    prompt: z.string().min(1).describe("Complete task instruction"),
    environmentId: z.string().nullable().optional(),
    model: z.string().min(1).nullable().optional().describe("Exact deployment-enabled model ID; omit or pass null to use the deployment default"),
    kickoffMessage: z.string().min(1).describe("Specific user-visible explanation of what is being delegated"),
  },
  execute: (args, context) => invoke("launch_task", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.manageTasks]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Inspect tasks in this Roomote deployment using the same read-only task actions and authorization semantics available to delegated Roomote tasks. Search task history, inspect status and failure details, read transcript messages, or fetch compute output where supported. Use launch_task, send_task_message, or cancel_task for task changes so Fast conversation orchestration is preserved.",
  args: {
    action: z.enum(${JSON.stringify(ROOMOTE_TASK_INSPECTION_ACTIONS)}),
    taskId: z.string().optional().describe("The task ID (required for get_summary, get_compute_logs, and get_messages)"),
    query: z.string().optional().describe("Text to search for in task prompts (for search action)"),
    status: z.enum(["active", "completed", "all"]).optional().describe("Filter by task status (for search action)"),
    pullRequest: z.string().optional().describe("Filter by pull request for search action: __has_pr__ for any linked PR or owner/repo#123 for a specific PR"),
    limit: z.number().int().min(1).max(1000).optional().describe("Positive result limit: 1 to 100 for search (default 20), or 1 to 1000 for get_messages"),
    cursor: z.string().optional().describe("Pagination cursor from a previous search response (nextCursor)"),
  },
  execute: (args, context) => invoke("manage_tasks", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Send a new instruction to an active task delegated by this Fast conversation.",
  args: {
    taskId: z.string().nullable().optional(),
    message: z.string().min(1),
  },
  execute: (args, context) => invoke("send_task_message", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.cancelTask]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Cancel an active task delegated by this Fast conversation.",
  args: { taskId: z.string().nullable().optional() },
  execute: (args, context) => invoke("cancel_task", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.integrationCall]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Call one available deployment MCP server tool with its native JSON arguments.",
  args: {
    integrationId: z.string().min(1),
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  },
  execute: (args, context) => invoke("integration_call", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.retryTaskStart]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Retry startup for the delegated task associated with an eligible failed platform event.",
  args: {},
  execute: (args, context) => invoke("retry_task_start", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.ignoreEvent]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Close a platform-generated event turn without posting a user-visible reply.",
  args: { reason: z.string().min(1) },
  execute: (args, context) => invoke("ignore_event", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Read a bounded UTF-8 byte window from an opaque Fast spill handle owned by this conversation. Never accepts filesystem paths.",
  args: {
    handle: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  },
  execute: (args, context) => invoke("spill_read", args, context),
}
`,

    [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep]: String.raw`
import { z } from "zod"
import { invoke } from "../roomote-fast-tool-bridge.js"

export default {
  description: "Search for a literal string inside an opaque Fast spill handle owned by this conversation. Returns bounded previews and byte offsets; never accepts filesystem paths.",
  args: {
    handle: z.string().min(1),
    query: z.string().min(1),
    maxMatches: z.number().int().positive().optional(),
  },
  execute: (args, context) => invoke("spill_grep", args, context),
}
`,
  };

const activeExecutors = new Map<string, ActiveExecutor>();
let runtimePromise: Promise<FastAgentNativeToolRuntime> | undefined;
const require = createRequire(import.meta.url);

function writeJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function utf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function serializeWithinOutputBudget(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (
    Buffer.byteLength(serialized, 'utf8') <=
    FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES
  ) {
    return serialized;
  }

  let previewBytes = FAST_AGENT_NATIVE_TOOL_PREVIEW_LIMIT_BYTES;
  while (previewBytes > 0) {
    const output = JSON.stringify({
      truncated: true,
      preview: utf8Prefix(serialized, previewBytes),
    });
    if (
      Buffer.byteLength(output, 'utf8') <=
      FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES
    ) {
      return output;
    }
    previewBytes = Math.floor(previewBytes / 2);
  }
  return JSON.stringify({ truncated: true, preview: '' });
}

function buildSpillOutput(
  sessionId: string,
  serialized: string,
): FastAgentBridgeOutput {
  const spill = fastAgentSpillStore.write(sessionId, serialized);
  let previewBytes = FAST_AGENT_NATIVE_TOOL_PREVIEW_LIMIT_BYTES;

  while (previewBytes >= 0) {
    const descriptor = spill.stored
      ? {
          truncated: true,
          preview: utf8Prefix(serialized, previewBytes),
          spill: {
            handle: spill.handle,
            byteLength: spill.byteLength,
            expiresAt: new Date(spill.expiresAt).toISOString(),
            guidance:
              'Delegate this handle to the spill_analysis subagent. Use spill_read or spill_grep; do not use filesystem paths.',
          },
        }
      : {
          truncated: true,
          preview: utf8Prefix(serialized, previewBytes),
          spill: {
            stored: false,
            byteLength: spill.byteLength,
            reason: spill.reason,
          },
        };
    const output = JSON.stringify(descriptor);
    if (
      Buffer.byteLength(output, 'utf8') <=
      FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES
    ) {
      return {
        output,
        metadata: {
          truncated: true,
          ...(spill.stored
            ? { spillHandle: spill.handle, spillByteLength: spill.byteLength }
            : { spillStored: false, spillReason: spill.reason }),
        },
      };
    }
    if (previewBytes === 0) break;
    previewBytes = Math.floor(previewBytes / 2);
  }

  throw new Error('Fast spill metadata exceeded the bridge output budget.');
}

function formatFastAgentNativeToolResult(
  sessionId: string,
  result: unknown,
  options: { allowSpill?: boolean } = {},
): FastAgentBridgeOutput {
  const serialized = JSON.stringify(result ?? null);
  if (
    Buffer.byteLength(serialized, 'utf8') <=
    FAST_AGENT_NATIVE_TOOL_OUTPUT_LIMIT_BYTES
  ) {
    return {
      output: serialized,
      metadata: { roomoteResult: result ?? null },
    };
  }
  if (options.allowSpill === false) {
    return {
      output: serializeWithinOutputBudget(result),
      metadata: { truncated: true },
    };
  }
  return buildSpillOutput(sessionId, serialized);
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > FAST_AGENT_TOOL_BRIDGE_BODY_LIMIT_BYTES) {
      throw new Error('Fast tool payload exceeded the bridge limit.');
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * The generated tool sources import zod, and OpenCode's own runtime loads
 * them from the tool directory — so a real zod package must exist on disk to
 * symlink there. In development that's the workspace install; in the app
 * image, where service bundles inline zod, it's the service runtime-deps tree
 * that ships next to the dist (asserted at image build). This wrapper exists
 * so a packaging regression names the requirement instead of surfacing as a
 * bare module-not-found mid-turn.
 */
function resolveZodDirectoryForTools(): string {
  try {
    return dirname(require.resolve('zod/package.json'));
  } catch (error) {
    throw new Error(
      'Fast native tools need the zod package on disk to link into the ' +
        'OpenCode tool directory, and none is resolvable from this process. ' +
        'In the app image zod ships in each service runtime-deps tree ' +
        '(asserted at image build); if this error reaches production, that ' +
        'service packaging step regressed. ' +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function startRuntime(): Promise<FastAgentNativeToolRuntime> {
  const token = randomBytes(32).toString('hex');
  const directory = mkdtempSync(join(tmpdir(), 'roomote-fast-opencode-'));
  const toolsDirectory = join(directory, '.opencode', 'tools');
  mkdirSync(toolsDirectory, { recursive: true });
  writeFileSync(
    join(directory, '.opencode', 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    'utf8',
  );
  const toolNodeModules = join(directory, '.opencode', 'node_modules');
  mkdirSync(toolNodeModules, { recursive: true });
  symlinkSync(
    resolveZodDirectoryForTools(),
    join(toolNodeModules, 'zod'),
    'dir',
  );
  writeFileSync(
    join(directory, '.opencode', 'roomote-fast-tool-bridge.js'),
    FAST_AGENT_NATIVE_TOOL_BRIDGE_SOURCE,
    'utf8',
  );
  for (const [name, source] of Object.entries(FAST_AGENT_NATIVE_TOOL_SOURCES)) {
    writeFileSync(join(toolsDirectory, `${name}.js`), source, 'utf8');
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/tool') {
      writeJson(response, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (!tokenMatches(request.headers.authorization, token)) {
      writeJson(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    try {
      const parsed = bridgeRequestSchema.parse(await readRequestBody(request));
      const activeExecutor = activeExecutors.get(parsed.sessionID);
      if (!activeExecutor) {
        writeJson(response, 409, {
          ok: false,
          error: 'The Fast turn is no longer active.',
        });
        return;
      }

      const call = {
        name: parsed.tool,
        args: parsed.args,
        ...(parsed.agent ? { agent: parsed.agent } : {}),
      };
      if (isFastAgentSpillSubagentTool(parsed.tool)) {
        const result =
          parsed.agent === ROOMOTE_OPENCODE_SPILL_ANALYSIS_AGENT_NAME
            ? (() => {
                try {
                  if (parsed.tool === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead) {
                    const args = spillReadArgsSchema.parse(parsed.args);
                    return {
                      success: true,
                      result: fastAgentSpillStore.read(
                        parsed.sessionID,
                        args.handle,
                        args.offset,
                        args.limit,
                      ),
                    };
                  }
                  const args = spillGrepArgsSchema.parse(parsed.args);
                  return {
                    success: true,
                    result: fastAgentSpillStore.grep(
                      parsed.sessionID,
                      args.handle,
                      args.query,
                      args.maxMatches,
                    ),
                  };
                } catch {
                  return {
                    success: false,
                    error:
                      'The spill handle is unavailable for this conversation or has expired.',
                  };
                }
              })()
            : {
                success: false,
                error: 'Spill tools are reserved for the spill_analysis agent.',
              };
        writeJson(response, 200, {
          ok: true,
          ...formatFastAgentNativeToolResult(parsed.sessionID, result, {
            allowSpill: false,
          }),
        });
        return;
      }

      const result = await activeExecutor.executor(call);
      writeJson(response, 200, {
        ok: true,
        ...formatFastAgentNativeToolResult(parsed.sessionID, result),
      });
    } catch (error) {
      console.error('[Fast Agent] Native tool bridge request failed.', error);
      writeJson(response, 400, {
        ok: false,
        error: FAST_AGENT_TOOL_BRIDGE_ERROR,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  process.once('exit', () => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fast tool bridge did not receive a TCP address.');
  }

  return {
    directory,
    env: {
      ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: token,
      ROOMOTE_FAST_TOOL_BRIDGE_URL: `http://127.0.0.1:${address.port}/tool`,
    },
  };
}

export function getFastAgentNativeToolRuntime(): Promise<FastAgentNativeToolRuntime> {
  runtimePromise ??= startRuntime();
  return runtimePromise;
}

export function bindFastAgentNativeToolExecutor(
  sessionID: string,
  conversationId: string,
  executor: FastAgentNativeToolExecutor,
): () => void {
  const existing = activeExecutors.get(sessionID);
  if (
    existing &&
    (existing.executor !== executor ||
      existing.conversationId !== conversationId)
  ) {
    throw new Error('The OpenCode session already has an active Fast turn.');
  }
  fastAgentSpillStore.bindSession(sessionID, conversationId);
  activeExecutors.set(sessionID, { conversationId, executor });

  return () => {
    const active = activeExecutors.get(sessionID);
    if (
      active?.executor === executor &&
      active.conversationId === conversationId
    ) {
      activeExecutors.delete(sessionID);
      fastAgentSpillStore.unbindSession(sessionID, conversationId);
    }
  };
}
