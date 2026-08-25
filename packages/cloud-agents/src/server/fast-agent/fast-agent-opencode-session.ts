import {
  isNonTaskOpenCodeSessionNotFoundError,
  type NonTaskOpenCodeSession,
} from '../non-task-provider-usage';
import { getOpenCodeSdkServerIdleTtlMs } from '../opencode-runtime';
import { fastAgentSpillStore } from './fast-agent-spill-store';

const DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT = 250;

type SessionEntry = {
  session: NonTaskOpenCodeSession;
  lastUsedAt: number;
  pending: number;
  tail: Promise<void>;
};

type FastAgentOpenCodeSessionRunInput<T> = {
  conversationId: string;
  prompt: string;
  bootstrapPrompt: string;
  execute: (
    session: NonTaskOpenCodeSession,
    selectedPrompt: string,
  ) => Promise<T>;
};

type FastAgentOpenCodeSessionManagerOptions = {
  idleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  onConversationEnd?: (conversationId: string) => Promise<void> | void;
};

/**
 * Process-local ownership for warm Fast OpenCode conversations. The map is
 * deliberately disposable: Roomote persists only stable conversation identity
 * and routing, while OpenCode owns the live transcript behind each session id.
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
    this.idleTtlMs = options.idleTtlMs ?? getOpenCodeSdkServerIdleTtlMs();
    this.maxEntries =
      options.maxEntries ?? DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT;
    this.now = options.now ?? Date.now;
    this.onConversationEnd =
      options.onConversationEnd ??
      ((conversationId) =>
        fastAgentSpillStore.cleanupConversation(conversationId));
  }

  async run<T>({
    conversationId,
    prompt,
    bootstrapPrompt,
    execute,
  }: FastAgentOpenCodeSessionRunInput<T>): Promise<T> {
    const entry = this.acquire(conversationId);
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.pending += 1;

    await previous;

    try {
      const selectedPrompt = entry.session.id ? prompt : bootstrapPrompt;
      const executeAndInvalidateOnFailure = async (
        nextPrompt: string,
      ): Promise<T> => {
        try {
          return await execute(entry.session, nextPrompt);
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
        return await executeAndInvalidateOnFailure(selectedPrompt);
      } catch (error) {
        if (!isNonTaskOpenCodeSessionNotFoundError(error)) {
          throw error;
        }

        return await executeAndInvalidateOnFailure(bootstrapPrompt);
      }
    } finally {
      entry.pending -= 1;
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
