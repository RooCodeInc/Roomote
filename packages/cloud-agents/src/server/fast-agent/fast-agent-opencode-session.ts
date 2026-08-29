import {
  isNonTaskOpenCodeSessionNotFoundError,
  type NonTaskOpenCodeSession,
} from '../non-task-provider-usage';
import { revokeFastAgentMcpCapabilitiesForConversation } from './fast-agent-native-tool-bridge';
import { fastAgentSpillStore } from './fast-agent-spill-store';

const DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT = 250;

type SessionEntry = {
  session: NonTaskOpenCodeSession;
  toolCatalogKey?: string;
  resumeValidationPending: boolean;
  generation: number;
  lastUsedAt: number;
  pending: number;
  tail: Promise<void>;
};

type FastAgentOpenCodeSessionRunInput<T> = {
  conversationId: string;
  persistedSessionId?: string | null;
  prompt: string;
  bootstrapPrompt: string;
  toolCatalogKey?: string;
  execute: (
    session: NonTaskOpenCodeSession,
    selectedPrompt: string,
    context: { path: FastAgentOpenCodeSessionPath; validateSession: boolean },
  ) => Promise<T>;
  onPathSelected?: (path: FastAgentOpenCodeSessionPath) => void;
};

type FastAgentOpenCodeSessionPath =
  | 'warm'
  | 'cold_resume'
  | 'cold_rebuild'
  | 'fallback_rebuild';

type FastAgentOpenCodeSessionManagerOptions = {
  idleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  onConversationEnd?: (conversationId: string) => Promise<void> | void;
};

/**
 * Process-local ownership for warm Fast OpenCode conversations. The map is
 * deliberately disposable: Roomote persists the last known session id, while
 * OpenCode owns the native transcript in its best-effort local storage.
 */
export class FastAgentOpenCodeSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onConversationEnd: (
    conversationId: string,
  ) => Promise<void> | void;

  constructor(options: FastAgentOpenCodeSessionManagerOptions = {}) {
    // The OpenCode server can restart after its own idle timeout without
    // losing sessions. Keep their ids until bounded LRU eviction instead.
    this.idleTtlMs = options.idleTtlMs ?? Number.POSITIVE_INFINITY;
    this.maxEntries =
      options.maxEntries ?? DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT;
    this.now = options.now ?? Date.now;
    this.onConversationEnd =
      options.onConversationEnd ??
      (async (conversationId) => {
        revokeFastAgentMcpCapabilitiesForConversation(conversationId);
        await fastAgentSpillStore.cleanupConversation(conversationId);
      });
  }

  async run<T>({
    conversationId,
    persistedSessionId,
    prompt,
    bootstrapPrompt,
    toolCatalogKey,
    execute,
    onPathSelected,
  }: FastAgentOpenCodeSessionRunInput<T>): Promise<T> {
    const entry = this.acquire(conversationId);
    const generationAtAcquire = entry.generation;
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.pending += 1;

    await previous;

    try {
      if (entry.generation === generationAtAcquire) {
        if (persistedSessionId && entry.session.id !== persistedSessionId) {
          entry.session.id = persistedSessionId;
          entry.resumeValidationPending = true;
        }
      }

      if (
        toolCatalogKey !== undefined &&
        entry.toolCatalogKey !== undefined &&
        entry.toolCatalogKey !== toolCatalogKey
      ) {
        entry.session.id = undefined;
        entry.resumeValidationPending = false;
        this.endConversation(conversationId);
      }
      entry.toolCatalogKey = toolCatalogKey;

      const validateSession = entry.resumeValidationPending;
      const path: FastAgentOpenCodeSessionPath = entry.session.id
        ? validateSession
          ? 'cold_resume'
          : 'warm'
        : 'cold_rebuild';
      entry.resumeValidationPending = false;
      onPathSelected?.(path);
      const executeAndInvalidateOnFailure = async (
        nextPrompt: string,
        context: {
          path: FastAgentOpenCodeSessionPath;
          validateSession: boolean;
        },
      ): Promise<T> => {
        try {
          return await execute(entry.session, nextPrompt, context);
        } catch (error) {
          // OpenCode persists the user turn before inference. Clear the failed
          // session before releasing queued work so the next turn cannot send
          // a delta into a poisoned transcript.
          entry.session.id = undefined;
          this.endConversation(conversationId);
          throw error;
        }
      };

      try {
        return await executeAndInvalidateOnFailure(
          entry.session.id ? prompt : bootstrapPrompt,
          { path, validateSession },
        );
      } catch (error) {
        if (!isNonTaskOpenCodeSessionNotFoundError(error)) {
          throw error;
        }

        onPathSelected?.('fallback_rebuild');
        return await executeAndInvalidateOnFailure(bootstrapPrompt, {
          path: 'fallback_rebuild',
          validateSession: false,
        });
      }
    } finally {
      entry.pending -= 1;
      entry.generation += 1;
      entry.lastUsedAt = this.now();
      this.touch(conversationId, entry);
      release();
      this.evict();
    }
  }

  clear(): void {
    for (const conversationId of this.entries.keys()) {
      this.endConversation(conversationId);
    }
    this.entries.clear();
  }

  /**
   * Discard a failed live transcript without disturbing queued turns. The next
   * run will rebuild the conversation from Roomote's compatibility history.
   */
  invalidate(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) {
      entry.session.id = undefined;
      this.endConversation(conversationId);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private acquire(conversationId: string): SessionEntry {
    this.evict();
    const existing = this.entries.get(conversationId);
    if (existing) {
      return existing;
    }

    const entry: SessionEntry = {
      session: {},
      resumeValidationPending: false,
      generation: 0,
      lastUsedAt: this.now(),
      pending: 0,
      tail: Promise.resolve(),
    };
    this.entries.set(conversationId, entry);
    return entry;
  }

  private touch(conversationId: string, entry: SessionEntry): void {
    if (this.entries.get(conversationId) !== entry) {
      return;
    }

    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
  }

  private evict(): void {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && now - entry.lastUsedAt >= this.idleTtlMs) {
        this.entries.delete(key);
        this.endConversation(key);
      }
    }

    if (this.entries.size <= this.maxEntries) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) {
        break;
      }
      if (entry.pending === 0) {
        this.entries.delete(key);
        this.endConversation(key);
      }
    }
  }

  private endConversation(conversationId: string): void {
    void Promise.resolve(this.onConversationEnd(conversationId)).catch(
      (error) => {
        console.error(
          '[Fast Agent] Failed to clean conversation spill data.',
          error,
        );
      },
    );
  }
}

export const fastAgentOpenCodeSessionManager =
  new FastAgentOpenCodeSessionManager();
