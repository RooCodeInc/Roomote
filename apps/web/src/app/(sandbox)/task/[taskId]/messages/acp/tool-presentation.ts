import {
  getMcpIntegration,
  type AcpToolCallPayload,
  type AcpToolResultPayload,
} from '@roomote/types';

import { sanitizeSandboxPathString } from '@/lib';

export type ToolPresentationCategory =
  | 'execute'
  | 'read'
  | 'search'
  | 'list'
  | 'edit'
  | 'subagent'
  | 'task'
  | 'communication'
  | 'memory'
  | 'artifact'
  | 'widget'
  | 'generic';

export type ToolIconKey =
  | 'terminal'
  | 'file'
  | 'folder'
  | 'search'
  | 'edit'
  | 'bot'
  | 'task'
  | 'message'
  | 'memory'
  | 'artifact'
  | 'widget'
  | 'roomote'
  | 'video'
  | 'target'
  | 'list-checks'
  | 'pull-request'
  | 'environment'
  | 'alert'
  | 'messages'
  | 'tool';

type ToolPresentationPhase = 'running' | 'completed' | 'failed';

type ToolData = AcpToolCallPayload | AcpToolResultPayload;

interface ResolvedToolPresentation {
  identity: {
    providerKind: 'native' | 'mcp';
    serverName: string | null;
    toolName: string | null;
  };
  category: ToolPresentationCategory;
  displayName: string;
  iconKey: ToolIconKey;
  integrationIcon?: string;
  phase: ToolPresentationPhase;
  verb: string;
  object?: string;
  providerLabel?: string;
  groupKey: string | null;
}

const SEARCH_TOOL_NAMES = new Set([
  'search',
  'search_file',
  'search_files',
  'spill_grep',
]);
const LIST_TOOL_NAMES = new Set([
  'glob',
  'list',
  'list_dir',
  'list_directory',
  'list_files',
  'list_skills',
]);
const READ_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'spill_read',
  'load_skill',
]);
const TASK_TOOL_NAMES = new Set([
  'launch_task',
  'retry_task_start',
  'cancel_task',
  'send_task_message',
]);
const COMMUNICATION_TOOL_NAMES = new Set([
  'send_chat_reply',
  'send_chat_reaction',
  'send_chat_reaction_emoji',
  'add_reaction_to_slack_message',
  'post_to_channel',
  'ignore_event',
]);
const TOOL_ICON_OVERRIDES: Readonly<Partial<Record<string, ToolIconKey>>> = {
  manage_custom_automations: 'task',
  get_about_me: 'roomote',
  describe_video: 'video',
  manage_goal: 'target',
  manage_tasks: 'list-checks',
  manage_source_control: 'pull-request',
  manage_environments: 'environment',
  save_task_memory: 'memory',
  request_environment_variables: 'terminal',
  report_platform_issue: 'alert',
  submit_automation_work_items: 'task',
  list_chat_channels: 'messages',
  get_chat_channel_messages: 'messages',
  get_chat_message_context: 'messages',
};

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase();
  return result ? result : null;
}

function formatToolIdentifier(value: string): string {
  if (value.toLowerCase() === 'gbrain') return 'Memory';

  return value
    .replace(/[.]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

export function resolveToolPresentation(
  data: ToolData,
  partial = false,
): ResolvedToolPresentation {
  const serverName = normalized(data.serverName ?? data.mcpServerName);
  const toolName = normalized(data.toolName ?? data.mcpToolName);
  const kind = normalized(data.kind);
  const providerKind = data.isMcp ? 'mcp' : 'native';
  const phase: ToolPresentationPhase =
    data.status === 'failed'
      ? 'failed'
      : data.status === 'in_progress' || partial
        ? 'running'
        : 'completed';
  const category = resolveToolCategory({
    kind,
    toolName,
    serverName,
    isExecute: data.isExecute,
    isRead: 'isRead' in data && data.isRead === true,
    isSubagentSpawn: data.isSubagentSpawn === true,
  });
  const explicitIconKey = toolName ? TOOL_ICON_OVERRIDES[toolName] : undefined;
  const integration =
    providerKind === 'mcp' && serverName
      ? getMcpIntegration(serverName)
      : undefined;
  const displayName = toolName
    ? formatToolIdentifier(toolName)
    : sanitizeSandboxPathString(data.title ?? 'Tool');
  const providerLabel =
    integration?.name ??
    (serverName ? formatToolIdentifier(serverName) : undefined);
  const receipt = resolveReceiptLanguage(toolName, phase);
  const verb = receipt?.verb ?? (phase === 'running' ? 'Using' : 'Used');
  const object = receipt?.object ?? displayName;

  return {
    identity: { providerKind, serverName, toolName },
    category,
    displayName,
    iconKey: explicitIconKey ?? categoryIconKey(category),
    integrationIcon: explicitIconKey ? undefined : integration?.icon,
    phase,
    verb,
    object,
    providerLabel,
    groupKey: resolveToolGroupKey({
      category,
      providerKind,
      serverName,
      toolName,
      kind,
    }),
  };
}

function resolveToolCategory(input: {
  kind: string | null;
  toolName: string | null;
  serverName: string | null;
  isExecute: boolean;
  isRead: boolean;
  isSubagentSpawn: boolean;
}): ToolPresentationCategory {
  if (input.kind === 'subagent' || input.isSubagentSpawn) return 'subagent';
  if (
    input.kind === 'execute' ||
    input.kind === 'execute_command' ||
    input.isExecute
  )
    return 'execute';
  if (
    input.kind === 'read' ||
    input.isRead ||
    (input.toolName && READ_TOOL_NAMES.has(input.toolName))
  )
    return 'read';
  if (
    input.kind === 'search' ||
    (input.toolName && SEARCH_TOOL_NAMES.has(input.toolName))
  )
    return 'search';
  if (
    input.kind === 'list' ||
    (input.toolName && LIST_TOOL_NAMES.has(input.toolName))
  )
    return 'list';
  if (input.kind === 'edit') return 'edit';
  if (
    input.kind === 'task' ||
    (input.toolName && TASK_TOOL_NAMES.has(input.toolName))
  )
    return 'task';
  if (
    input.kind === 'communication' ||
    (input.toolName && COMMUNICATION_TOOL_NAMES.has(input.toolName))
  )
    return 'communication';
  if (
    input.kind === 'memory' ||
    input.serverName === 'gbrain' ||
    input.toolName === 'save_memory'
  )
    return 'memory';
  if (input.kind === 'artifact' || input.toolName === 'manage_artifacts')
    return 'artifact';
  if (input.kind === 'widget' || input.toolName === 'show_widget')
    return 'widget';
  return 'generic';
}

function categoryIconKey(category: ToolPresentationCategory): ToolIconKey {
  if (category === 'execute') return 'terminal';
  if (category === 'read') return 'file';
  if (category === 'list') return 'folder';
  if (category === 'search') return 'search';
  if (category === 'edit') return 'edit';
  if (category === 'subagent') return 'bot';
  if (category === 'task') return 'task';
  if (category === 'communication') return 'message';
  if (category === 'memory') return 'memory';
  if (category === 'artifact') return 'artifact';
  if (category === 'widget') return 'widget';
  return 'tool';
}

function resolveToolGroupKey(input: {
  category: ToolPresentationCategory;
  providerKind: 'native' | 'mcp';
  serverName: string | null;
  toolName: string | null;
  kind: string | null;
}): string | null {
  if (input.category === 'subagent') return null;
  if (input.category === 'execute') return 'execute';
  if (input.toolName) {
    return input.providerKind === 'mcp' && input.serverName
      ? `mcp:${input.serverName}:${input.toolName}`
      : `tool:${input.toolName}`;
  }
  return input.kind && input.kind !== 'mcp' ? `kind:${input.kind}` : null;
}

function resolveReceiptLanguage(
  toolName: string | null,
  phase: ToolPresentationPhase,
): { verb: string; object: string } | null {
  const byPhase = (running: string, completed: string, failed: string) =>
    phase === 'running' ? running : phase === 'failed' ? failed : completed;

  if (toolName === 'launch_task')
    return {
      verb: byPhase('Starting', 'Started', 'Failed to Start'),
      object: 'Coding Task',
    };
  if (toolName === 'cancel_task')
    return {
      verb: byPhase('Cancelling', 'Cancelled', 'Failed to Cancel'),
      object: 'Task',
    };
  if (toolName === 'retry_task_start')
    return {
      verb: byPhase('Retrying', 'Retried', 'Failed to Retry'),
      object: 'Task',
    };
  if (toolName === 'send_task_message')
    return {
      verb: byPhase('Sending', 'Sent', 'Failed to Send'),
      object: 'Task Message',
    };
  if (toolName === 'save_memory')
    return {
      verb: byPhase('Saving', 'Saved', 'Failed to Save'),
      object: 'Memory',
    };
  return null;
}

export function summarizeToolGroup(
  category: ToolPresentationCategory,
  count: number,
  displayName: string,
): { action: string; objectSummary: string } {
  if (category === 'execute')
    return {
      action: 'Ran',
      objectSummary: `${count} ${count === 1 ? 'command' : 'commands'}`,
    };
  if (category === 'search')
    return {
      action: 'Exploring',
      objectSummary: `${count} ${count === 1 ? 'search' : 'searches'}`,
    };
  if (category === 'list')
    return {
      action: 'Exploring',
      objectSummary: `${count} ${count === 1 ? 'listing' : 'listings'}`,
    };
  if (category === 'read')
    return {
      action: 'Exploring',
      objectSummary: `${count} ${count === 1 ? 'file' : 'files'}`,
    };
  if (category === 'edit')
    return {
      action: 'Edited',
      objectSummary: `${count} ${count === 1 ? 'file' : 'files'}`,
    };

  const label = displayName.toLowerCase();
  return {
    action: 'Used',
    objectSummary: count === 1 ? `1 ${label}` : `${count} ${label} calls`,
  };
}
