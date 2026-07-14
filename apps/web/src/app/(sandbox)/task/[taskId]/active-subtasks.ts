'use client';

import type { AcpToolCallPayload, AcpToolResultPayload } from '@roomote/types';

import type { AcpUiMessage } from './messages/acp/types';
import { isSubagentToolMessage } from './messages/acp/subagent-tool';

type ActiveSubtaskStatus = 'pending' | 'in_progress';

interface ActiveSubtask {
  id: string;
  name: string;
  agentTypeLabel: string;
  status: ActiveSubtaskStatus;
  startedAt: number;
}

type SubagentNameSource = 'prompt' | 'title' | 'fallback';

interface ActiveSubtaskDraft extends ActiveSubtask {
  nameSource: SubagentNameSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatAgentTypeLabel(
  agentType: string | null | undefined,
): string | null {
  const normalized = agentType?.trim();

  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function getActiveSubtaskAgentTypeLabel(
  payload: AcpToolCallPayload | AcpToolResultPayload,
): string {
  return formatAgentTypeLabel(payload.agentType) ?? 'Subagent';
}

function getSubtaskPrompt(
  payload: AcpToolCallPayload | AcpToolResultPayload,
): string | null {
  const topLevelPrompt = asString(payload.prompt);

  if (topLevelPrompt) {
    return topLevelPrompt;
  }

  const rawInput = (payload as unknown as Record<string, unknown>).rawInput;

  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return null;
  }

  return asString((rawInput as Record<string, unknown>).prompt);
}

function getSubtaskName(payload: AcpToolCallPayload | AcpToolResultPayload): {
  name: string;
  source: SubagentNameSource;
} {
  const prompt = getSubtaskPrompt(payload);

  if (prompt) {
    return {
      name: prompt,
      source: 'prompt',
    };
  }

  const title = asString(payload.title);

  if (title) {
    return {
      name: title,
      source: 'title',
    };
  }

  return {
    name: getActiveSubtaskAgentTypeLabel(payload),
    source: 'fallback',
  };
}

function normalizeActiveSubtaskStatus(
  rawStatus: string | null | undefined,
): ActiveSubtaskStatus | null {
  const normalized = rawStatus?.trim().toLowerCase();

  if (!normalized) {
    return 'in_progress';
  }

  if (
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'aborted' ||
    normalized === 'canceled' ||
    normalized === 'cancelled' ||
    normalized === 'timeout' ||
    normalized === 'timed_out'
  ) {
    return null;
  }

  if (
    normalized === 'pending' ||
    normalized === 'pendinginit' ||
    normalized === 'queued' ||
    normalized === 'starting'
  ) {
    return 'pending';
  }

  return 'in_progress';
}

function getUniqueReceiverThreadIds(
  payload: AcpToolCallPayload | AcpToolResultPayload,
): string[] {
  const receiverThreadIds = payload.receiverThreadIds;

  if (!Array.isArray(receiverThreadIds) || receiverThreadIds.length === 0) {
    return [];
  }

  return [...new Set(receiverThreadIds.filter(Boolean))];
}

function getSubtaskNameSourcePriority(source: SubagentNameSource): number {
  switch (source) {
    case 'prompt':
      return 3;
    case 'title':
      return 2;
    case 'fallback':
      return 1;
  }
}

function createActiveSubtaskDraft(options: {
  id: string;
  payload: AcpToolCallPayload | AcpToolResultPayload;
  startedAt: number;
  status: ActiveSubtaskStatus;
}): ActiveSubtaskDraft {
  const name = getSubtaskName(options.payload);

  return {
    id: options.id,
    name: name.name,
    nameSource: name.source,
    agentTypeLabel: getActiveSubtaskAgentTypeLabel(options.payload),
    startedAt: options.startedAt,
    status: options.status,
  };
}

function mergeActiveSubtaskDraft(
  existing: ActiveSubtaskDraft,
  incoming: ActiveSubtaskDraft,
): ActiveSubtaskDraft {
  const shouldUseIncomingName =
    getSubtaskNameSourcePriority(incoming.nameSource) >
    getSubtaskNameSourcePriority(existing.nameSource);

  return {
    ...incoming,
    name: shouldUseIncomingName ? incoming.name : existing.name,
    nameSource: shouldUseIncomingName
      ? incoming.nameSource
      : existing.nameSource,
    agentTypeLabel:
      incoming.agentTypeLabel === 'Subagent'
        ? existing.agentTypeLabel
        : incoming.agentTypeLabel,
    startedAt: Math.min(existing.startedAt, incoming.startedAt),
  };
}

function stripActiveSubtaskDraft(subtask: ActiveSubtaskDraft): ActiveSubtask {
  return {
    id: subtask.id,
    name: subtask.name,
    agentTypeLabel: subtask.agentTypeLabel,
    startedAt: subtask.startedAt,
    status: subtask.status,
  };
}

export function getActiveSubtasks(messages: AcpUiMessage[]): ActiveSubtask[] {
  const activeSubtasksByThreadId = new Map<string, ActiveSubtaskDraft>();
  const pendingSubtasksByToolCallId = new Map<string, ActiveSubtaskDraft>();
  const toolCallIdsWithResolvedThreadIds = new Set<string>();

  for (const message of messages) {
    if (!message || !isSubagentToolMessage(message)) {
      continue;
    }

    const payload = message.data;
    const toolCallId = asString(payload.toolCallId) ?? message.id;
    const receiverThreadIds = getUniqueReceiverThreadIds(payload);
    const agentStates = asRecord(payload.agentsStates) ?? {};
    const startedAt = Number.isFinite(message.ts) ? message.ts : 0;

    if (receiverThreadIds.length === 0) {
      if (!toolCallId || toolCallIdsWithResolvedThreadIds.has(toolCallId)) {
        continue;
      }

      const status = normalizeActiveSubtaskStatus(payload.status);

      if (!status) {
        pendingSubtasksByToolCallId.delete(toolCallId);
        continue;
      }

      const nextPendingSubtask = createActiveSubtaskDraft({
        id: `tool:${toolCallId}`,
        payload,
        startedAt,
        status: 'pending',
      });
      const existingPendingSubtask =
        pendingSubtasksByToolCallId.get(toolCallId);

      pendingSubtasksByToolCallId.set(
        toolCallId,
        existingPendingSubtask
          ? mergeActiveSubtaskDraft(existingPendingSubtask, nextPendingSubtask)
          : nextPendingSubtask,
      );

      continue;
    }

    if (toolCallId) {
      toolCallIdsWithResolvedThreadIds.add(toolCallId);
      pendingSubtasksByToolCallId.delete(toolCallId);
    }

    for (const receiverThreadId of receiverThreadIds) {
      const agentState = asRecord(agentStates[receiverThreadId]);
      const status = normalizeActiveSubtaskStatus(
        asString(agentState?.status) ?? payload.status,
      );

      if (!status) {
        activeSubtasksByThreadId.delete(receiverThreadId);
        continue;
      }

      const nextActiveSubtask = createActiveSubtaskDraft({
        id: receiverThreadId,
        payload,
        startedAt,
        status,
      });
      const existingActiveSubtask =
        activeSubtasksByThreadId.get(receiverThreadId);

      activeSubtasksByThreadId.set(
        receiverThreadId,
        existingActiveSubtask
          ? mergeActiveSubtaskDraft(existingActiveSubtask, nextActiveSubtask)
          : nextActiveSubtask,
      );
    }
  }

  return [
    ...activeSubtasksByThreadId.values(),
    ...pendingSubtasksByToolCallId.values(),
  ]
    .sort((left, right) => left.startedAt - right.startedAt)
    .map(stripActiveSubtaskDraft);
}
