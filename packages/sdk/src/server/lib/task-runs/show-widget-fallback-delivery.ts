import { getRedis } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  asBoolean,
  asRecord,
  asString,
  type AcpPersistedEnvelope,
  type ShowWidgetFallbackDelivery,
} from '@roomote/types';

const SHOW_WIDGET_MCP_SERVER_NAME = 'roomote';
const SHOW_WIDGET_TOOL_NAME = 'show_widget';
const SHOW_WIDGET_FALLBACK_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHOW_WIDGET_FALLBACK_CLAIM_KEY_PREFIX = 'show-widget-fallback:';

function asTrimmedString(value: unknown): string | null {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value)) ?? null;
  } catch {
    return null;
  }
}

export function extractShowWidgetFallbackDelivery(
  envelope: AcpPersistedEnvelope,
  taskId: string,
): ShowWidgetFallbackDelivery | null {
  if (envelope.eventType !== ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
    return null;
  }

  const payload = asRecord(envelope.payload);
  if (!payload || asBoolean(payload.isMcp) !== true) {
    return null;
  }

  const serverName = asTrimmedString(
    payload.mcpServerName ?? payload.serverName,
  )?.toLowerCase();
  const toolName = asTrimmedString(payload.mcpToolName ?? payload.toolName);
  const toolCallId = asTrimmedString(payload.toolCallId);
  const status = asTrimmedString(payload.status);

  if (
    serverName !== SHOW_WIDGET_MCP_SERVER_NAME ||
    toolName !== SHOW_WIDGET_TOOL_NAME ||
    !toolCallId ||
    status !== 'completed'
  ) {
    return null;
  }

  const output = asTrimmedString(payload.output);
  const result = output ? parseJsonRecord(output) : null;
  const textFallback = asTrimmedString(result?.textFallback);

  if (
    !result ||
    asBoolean(result.success) !== true ||
    asBoolean(result.shown) !== true ||
    !textFallback
  ) {
    return null;
  }

  const widgetUrl = new URL(
    `/task/${taskId}`,
    process.env.R_PUBLIC_URL ?? process.env.R_APP_URL,
  );
  widgetUrl.hash = `msg-${envelope.ts}`;

  return {
    toolCallId,
    title: asTrimmedString(result.title),
    textFallback,
    widgetUrl: widgetUrl.toString(),
  };
}

function getClaimKey(runId: number, toolCallId: string): string {
  return `${SHOW_WIDGET_FALLBACK_CLAIM_KEY_PREFIX}${runId}:${toolCallId}`;
}

export async function claimShowWidgetFallbackDelivery(input: {
  runId: number;
  toolCallId: string;
}): Promise<{ claimed: boolean }> {
  const claim = await getRedis().set(
    getClaimKey(input.runId, input.toolCallId),
    '1',
    'EX',
    SHOW_WIDGET_FALLBACK_CLAIM_TTL_SECONDS,
    'NX',
  );

  return { claimed: claim === 'OK' };
}

export async function releaseShowWidgetFallbackDelivery(input: {
  runId: number;
  toolCallId: string;
}): Promise<void> {
  await getRedis().del(getClaimKey(input.runId, input.toolCallId));
}
