import {
  isNonTaskOpenCodeSessionNotFoundError,
  type NonTaskOpenCodeSession,
} from '../non-task-provider-usage';
import { getOpenCodeSdkServerIdleTtlMs } from '../opencode-runtime';

const DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT = 250;

type SessionEntry = {
  session: NonTaskOpenCodeSession;
  resumeValidationPending: boolean;
  lastUsedAt: number;
  pending: number;
  tail: Promise<void>;
};

type FastAgentOpenCodeSessionRunInput<T> = {
  conversationId: string;
  persistedSessionId?: string | null;
  prompt: string;
  bootstrapPrompt: string;
  execute: (
    session: NonTaskOpenCodeSession,
    selectedPrompt: string,
    context: { path: FastAgentOpenCodeSessionPath; validateSession: boolean },
  ) => Promise<T>;
  onPathSelected?: (path: FastAgentOpenCodeSessionPath) => void;
};

export type FastAgentOpenCodeSessionPath =
  | 'warm'
  | 'cold_resume'
  | 'cold_rebuild'
  | 'fallback_rebuild';

type FastAgentOpenCodeSessionManagerOptions = {
  idleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

/**
 * Process-local ownership for warm Fast OpenCode conversations. The map is
 * deliberately disposable: Roomote durably persists the OpenCode session id,
 * while OpenCode owns the native transcript behind it.
 */
export class FastAgentOpenCodeSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: FastAgentOpenCodeSessionManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? getOpenCodeSdkServerIdleTtlMs();
    this.maxEntries =
      options.maxEntries ?? DEFAULT_FAST_AGENT_OPENCODE_SESSION_LIMIT;
    this.now = options.now ?? Date.now;
  }

  async run<T>({
    conversationId,
    persistedSessionId,
    prompt,
    bootstrapPrompt,
    execute,
    onPathSelected,
  }: FastAgentOpenCodeSessionRunInput<T>): Promise<T> {
    const entry = this.acquire(conversationId, persistedSessionId);
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.pending += 1;

    await previous;

    try {
      if (persistedSessionId && persistedSessionId !== entry.session.id) {
        entry.session.id = persistedSessionId;
        entry.resumeValidationPending = true;
      }
      const validateSession = entry.resumeValidationPending;
      const path: FastAgentOpenCodeSessionPath = entry.session.id
        ? validateSession
          ? 'cold_resume'
          : 'warm'
        : 'cold_rebuild';
      entry.resumeValidationPending = false;
      onPathSelected?.(path);

      try {
        return await execute(
          entry.session,
          entry.session.id ? prompt : bootstrapPrompt,
          { path, validateSession },
        );
      } catch (error) {
        if (!isNonTaskOpenCodeSessionNotFoundError(error)) {
          throw error;
        }

        entry.session.id = undefined;
        onPathSelected?.('fallback_rebuild');
        return await execute(entry.session, bootstrapPrompt, {
          path: 'fallback_rebuild',
          validateSession: false,
        });
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
    this.entries.clear();
  }

  /**
   * Drop process-local ownership without deleting the durable session id. The
   * next run validates that id before deciding whether to resume or rebuild.
   */
  invalidate(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry?.session.id) {
      entry.resumeValidationPending = true;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private acquire(
    conversationId: string,
    persistedSessionId?: string | null,
  ): SessionEntry {
    this.evict();
    const existing = this.entries.get(conversationId);
    if (existing) {
      return existing;
    }

    const entry: SessionEntry = {
      session: { id: persistedSessionId ?? undefined },
      resumeValidationPending: Boolean(persistedSessionId),
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
      }
    }
  }
}

export const fastAgentOpenCodeSessionManager =
  new FastAgentOpenCodeSessionManager();
