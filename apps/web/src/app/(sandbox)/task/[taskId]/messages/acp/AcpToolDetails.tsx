import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';
import { redactSecrets } from '@roomote/communication/redact-secrets';
import YAML from 'yaml';

import {
  CodeBlock,
  MessageResponse,
  ToolInput,
} from '@/components/ai-elements';
import {
  ChevronRight,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/system';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { isSubagentToolPayload } from './subagent-tool';
import {
  getSubagentLastMessage,
  getSubagentPrompt,
  hidesExpandedToolResult,
} from './tool-detail-visibility';

interface AcpToolDetailsProps {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  maxHeight?: number;
  showSubagentPayload?: boolean;
}

export function AcpToolDetails({
  msg,
  maxHeight = 400,
  showSubagentPayload = false,
}: AcpToolDetailsProps) {
  if (hidesExpandedToolResult(msg, { showSubagentPayload })) {
    return null;
  }

  const sanitizedToolData = sanitizeSandboxPathsForDisplay(msg.data);
  const visibleToolInput = getVisibleToolInput(msg.data);
  const isSubagent = isSubagentToolPayload(msg.data);
  const subagentPrompt = getSubagentPrompt(msg);
  const subagentLastMessage = getSubagentLastMessage(msg);

  if (isSubagent && showSubagentPayload) {
    return (
      <ToolInput
        input={sanitizedToolData}
        style={{
          maxHeight,
          overflow: 'auto',
        }}
      />
    );
  }

  if (isSubagent && (subagentPrompt || subagentLastMessage)) {
    return (
      <div
        className="space-y-3 text-sm font-light text-muted-foreground"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {subagentLastMessage ? (
          <MessageResponse>
            {sanitizeSandboxPathString(subagentLastMessage)}
          </MessageResponse>
        ) : null}
        {subagentPrompt ? (
          <Collapsible
            defaultOpen={!subagentLastMessage}
            className="group/acp-subagent-prompt"
          >
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 text-sm font-light text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <ChevronRight className="size-4 transition-transform group-data-[state=open]/acp-subagent-prompt:rotate-90" />
              <span>Prompt</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 ml-2 whitespace-pre-wrap border-l border-border pl-4 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
              {sanitizeSandboxPathString(subagentPrompt)}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    );
  }

  const rawResult =
    msg.kind === 'tool_result'
      ? msg.data.output || msg.text
      : visibleToolInput
        ? undefined
        : msg.text;
  const sanitizedResult = rawResult
    ? sanitizeSandboxPathString(rawResult)
    : undefined;
  const formattedInput = formatStructuredValue(visibleToolInput);
  const formattedResult = formatToolResult(
    sanitizedResult,
    Boolean(formattedInput),
  );

  if (formattedInput || formattedResult) {
    return (
      <div className="space-y-3">
        {formattedInput ? (
          <ToolDetailSection
            label="Input"
            code={formattedInput.code}
            language="yaml"
            maxHeight={maxHeight}
          />
        ) : null}
        {formattedResult ? (
          <ToolDetailSection
            label="Result"
            code={formattedResult.code}
            language={formattedResult.isStructured ? 'yaml' : 'bash'}
            maxHeight={maxHeight}
          />
        ) : null}
      </div>
    );
  }

  return (
    <ToolInput
      input={sanitizedToolData}
      style={{
        maxHeight,
        overflow: 'auto',
      }}
    />
  );
}

function ToolDetailSection({
  label,
  code,
  language,
  maxHeight,
}: {
  label: string;
  code: string;
  language: 'yaml' | 'bash';
  maxHeight: number;
}) {
  return (
    <section className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <CodeBlock
        code={code}
        language={language}
        maxHeight={maxHeight}
        variant="compact"
        highlight={false}
        className="[&>div]:rounded-none [&>div]:bg-transparent [&_pre]:px-0 [&_pre]:py-0"
      />
    </section>
  );
}

function formatStructuredValue(
  value: Record<string, string> | null,
): { code: string } | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;

  return {
    code: YAML.stringify(value, { indent: 2, lineWidth: 0 }).trimEnd(),
  };
}

function formatToolResult(
  text: string | undefined,
  hasVisibleInput: boolean,
): { code: string; isStructured: boolean } | undefined {
  if (!text) return undefined;

  try {
    const result = JSON.parse(text) as unknown;
    if (!result || typeof result !== 'object') {
      return { code: text, isStructured: false };
    }

    return {
      code: YAML.stringify(result, { indent: 2, lineWidth: 0 }).trimEnd(),
      isStructured: true,
    };
  } catch {
    return hasVisibleInput
      ? {
          code: YAML.stringify(text, { lineWidth: 0 }).trimEnd(),
          isStructured: true,
        }
      : { code: text, isStructured: false };
  }
}

function getVisibleToolInput(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
): Record<string, string> | null {
  const record = data as unknown as Record<string, unknown>;
  const serverName = (
    data.serverName ??
    data.mcpServerName ??
    ''
  ).toLowerCase();
  const toolName = (data.toolName ?? data.mcpToolName ?? data.title ?? '')
    .toLowerCase()
    .replace(/^.*[.:/]/, '');

  const visibleField =
    serverName === 'gbrain' && (toolName === 'search' || toolName === 'query')
      ? 'query'
      : toolName === 'send_task_message'
        ? 'message'
        : null;
  if (!visibleField) {
    return null;
  }

  const rawInput = record.rawInput;
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return {};
  }

  const rawInputRecord = rawInput as Record<string, unknown>;
  const nestedArguments = rawInputRecord.arguments;
  const args =
    nestedArguments &&
    typeof nestedArguments === 'object' &&
    !Array.isArray(nestedArguments)
      ? (nestedArguments as Record<string, unknown>)
      : rawInputRecord;
  const value = args[visibleField];

  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  return {
    [visibleField]: sanitizeSandboxPathString(redactSecrets(value)),
  };
}
