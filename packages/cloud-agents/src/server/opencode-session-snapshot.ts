import { randomBytes } from 'node:crypto';

import type {
  Message,
  Part,
  Session,
  ToolPart,
} from '@opencode-ai/sdk/v2/client';
import { z } from 'zod';

export const OPENCODE_SESSION_SNAPSHOT_MAX_MESSAGES = 500;
const OPENCODE_SESSION_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export type OpenCodeSessionSnapshot = {
  version: 1;
  sourceSessionId: string;
  capturedAt: number;
  info: Session;
  messages: Array<{ info: Message; parts: Part[] }>;
};

const snapshotSchema = z.object({
  version: z.literal(1),
  sourceSessionId: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  info: z.object({ id: z.string().min(1) }).passthrough(),
  messages: z.array(
    z.object({
      info: z.object({ id: z.string().min(1) }).passthrough(),
      parts: z.array(z.object({ id: z.string().min(1) }).passthrough()),
    }),
  ),
});

function createOpenCodeIdFactory() {
  const seed = Date.now().toString(16).padStart(12, '0').slice(-12);
  let sequence = 0;
  return (prefix: 'ses' | 'msg' | 'prt'): string => {
    const ordered = sequence.toString(16).padStart(6, '0').slice(-6);
    sequence += 1;
    return `${prefix}_${seed}${ordered}${randomBytes(4).toString('hex')}`;
  };
}

export function parseOpenCodeSessionSnapshot(
  value: unknown,
): OpenCodeSessionSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.info.id !== parsed.data.sourceSessionId) {
    return null;
  }

  const snapshot = parsed.data as OpenCodeSessionSnapshot;
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (
    snapshot.messages.length > OPENCODE_SESSION_SNAPSHOT_MAX_MESSAGES ||
    serializedBytes > OPENCODE_SESSION_SNAPSHOT_MAX_BYTES
  ) {
    return null;
  }
  return snapshot;
}

export function createOpenCodeSessionSnapshot(input: {
  info: Session;
  messages: Array<{ info: Message; parts: Part[] }>;
  expectedCompletedMessageId: string;
  capturedAt?: number;
}): OpenCodeSessionSnapshot | null {
  if (
    input.messages.length === 0 ||
    input.messages.length > OPENCODE_SESSION_SNAPSHOT_MAX_MESSAGES ||
    !input.messages.some(
      ({ info }) =>
        info.id === input.expectedCompletedMessageId &&
        info.role === 'assistant' &&
        info.time.completed !== undefined,
    ) ||
    input.messages.some(
      ({ info, parts }) =>
        (info.role === 'assistant' && info.time.completed === undefined) ||
        parts.some(
          (part) =>
            part.type === 'tool' &&
            (part.state.status === 'pending' ||
              part.state.status === 'running'),
        ),
    )
  ) {
    return null;
  }

  return parseOpenCodeSessionSnapshot({
    version: 1,
    sourceSessionId: input.info.id,
    capturedAt: input.capturedAt ?? Date.now(),
    info: input.info,
    messages: input.messages,
  });
}

export function sanitizeOpenCodeSessionSnapshot(
  snapshot: OpenCodeSessionSnapshot,
  shouldRedact: (part: ToolPart) => boolean,
): OpenCodeSessionSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map(({ info, parts }) => {
      // The current turn supplies a fresh system prompt. Persisting historical
      // copies would retain speaker-specific personalization unnecessarily.
      const sanitizedInfo = (() => {
        if (info.role !== 'user') return info;
        const { system: _system, ...safeInfo } = info;
        return safeInfo;
      })();
      return {
        info: sanitizedInfo,
        parts: parts.map((part): Part => {
          if (part.type !== 'tool' || !shouldRedact(part)) return part;
          if (part.state.status === 'completed') {
            return {
              ...part,
              metadata: undefined,
              state: {
                ...part.state,
                input: {},
                output: 'Private tool result omitted from durable recovery.',
                metadata: {},
                attachments: undefined,
              },
            };
          }
          if (part.state.status === 'error') {
            return {
              ...part,
              metadata: undefined,
              state: {
                ...part.state,
                input: {},
                error: 'Private tool error omitted from durable recovery.',
                metadata: undefined,
              },
            };
          }
          if (part.state.status === 'running') {
            return {
              ...part,
              metadata: undefined,
              state: {
                ...part.state,
                input: {},
                title: undefined,
                metadata: undefined,
              },
            };
          }
          return {
            ...part,
            metadata: undefined,
            state: { ...part.state, input: {}, raw: '' },
          };
        }),
      };
    }),
  };
}

export function cloneOpenCodeSessionSnapshotForImport(
  snapshot: OpenCodeSessionSnapshot,
): OpenCodeSessionSnapshot {
  const createOpenCodeId = createOpenCodeIdFactory();
  const sessionId = createOpenCodeId('ses');
  const messageIds = new Map(
    snapshot.messages.map(({ info }) => [info.id, createOpenCodeId('msg')]),
  );

  const messages = snapshot.messages.map(({ info, parts }) => {
    const messageId = messageIds.get(info.id)!;
    const nextInfo: Message =
      info.role === 'assistant'
        ? {
            ...info,
            id: messageId,
            sessionID: sessionId,
            parentID: messageIds.get(info.parentID) ?? info.parentID,
          }
        : { ...info, id: messageId, sessionID: sessionId };
    const nextParts = parts.map((part): Part => {
      const base = {
        ...part,
        id: createOpenCodeId('prt'),
        sessionID: sessionId,
        messageID: messageId,
      };
      if (base.type === 'compaction' && base.tail_start_id) {
        return {
          ...base,
          tail_start_id:
            messageIds.get(base.tail_start_id) ?? base.tail_start_id,
        };
      }
      if (
        base.type === 'tool' &&
        base.state.status === 'completed' &&
        base.state.attachments
      ) {
        return {
          ...base,
          state: {
            ...base.state,
            attachments: base.state.attachments.map((attachment) => ({
              ...attachment,
              id: createOpenCodeId('prt'),
              sessionID: sessionId,
              messageID: messageId,
            })),
          },
        };
      }
      return base;
    });
    return { info: nextInfo, parts: nextParts };
  });

  return {
    version: 1,
    sourceSessionId: sessionId,
    capturedAt: snapshot.capturedAt,
    info: {
      ...snapshot.info,
      id: sessionId,
      slug: `roomote-restore-${sessionId.slice(-8)}`,
      parentID: undefined,
      share: undefined,
      revert: undefined,
    },
    messages,
  };
}
