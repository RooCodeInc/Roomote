/**
 * Process-wide cache for the Git-backed skill snapshots the Fast system prompt
 * lists. Building the prompt runs on every turn, and a snapshot is a fresh
 * `git fetch`, so without this each turn waits on one fetch per repository
 * and marketplace source before inference can start.
 *
 * A snapshot younger than `freshMs` is returned as is. An older one is still
 * returned, while a single background load replaces it. With nothing cached,
 * the caller waits at most `coldWaitMs` and then gets a rejection, which the
 * skill sources already report as "could not be inspected": the turn proceeds
 * without those skills and the load finishes in the background for the next
 * turn. `list_skills` and `load_skill` use their own uncached sources, so a
 * cached listing only ever affects which names the prompt shows.
 *
 * The prompt reads a snapshot's records, never its checkout, so the cache
 * removes the checkout as soon as the load resolves, and keeps only what
 * `retain` returns: a listing, without whatever the load needed to reach Git.
 *
 * A load that fails is not repeated for `retryMs`. Without that, a source
 * that fails quickly would be fetched again on every turn, which is the work
 * this cache exists to remove.
 */
type CacheEntry<TSnapshot> = {
  loadedAt: number;
  snapshot: TSnapshot;
};

type FastAgentPromptSkillSnapshotCacheOptions<TSnapshot> = {
  /** Removes the snapshot's on-disk checkout. */
  cleanup: (snapshot: TSnapshot) => Promise<void>;
  coldWaitMs?: number;
  freshMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** The part of a loaded snapshot worth keeping for up to `staleMs`. */
  retain?: (snapshot: TSnapshot) => TSnapshot;
  /** How long a key is left alone after its load fails. */
  retryMs?: number;
  /** How long a snapshot may be served while a replacement loads. */
  staleMs?: number;
};

const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 60 * 60_000;
const DEFAULT_COLD_WAIT_MS = 1_500;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 128;

export class FastAgentPromptSkillSnapshotCache<TSnapshot> {
  private readonly cleanup: (snapshot: TSnapshot) => Promise<void>;
  private readonly coldWaitMs: number;
  private readonly entries = new Map<string, CacheEntry<TSnapshot>>();
  private readonly freshMs: number;
  private readonly inflight = new Map<string, Promise<TSnapshot>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly retain: (snapshot: TSnapshot) => TSnapshot;
  private readonly retryAt = new Map<string, number>();
  private readonly retryMs: number;
  private readonly staleMs: number;

  constructor(options: FastAgentPromptSkillSnapshotCacheOptions<TSnapshot>) {
    this.cleanup = options.cleanup;
    this.coldWaitMs = options.coldWaitMs ?? DEFAULT_COLD_WAIT_MS;
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.retain = options.retain ?? ((snapshot) => snapshot);
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  }

  async get(key: string, load: () => Promise<TSnapshot>): Promise<TSnapshot> {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.loadedAt : undefined;

    const backingOff = (this.retryAt.get(key) ?? 0) > this.now();

    if (entry && age !== undefined && age < this.staleMs) {
      if (age >= this.freshMs && !backingOff) {
        // Refresh behind the caller; a failed refresh keeps serving the entry
        // until it ages out.
        void this.load(key, load).catch(() => undefined);
      }
      return entry.snapshot;
    }

    if (backingOff) {
      throw new Error('Skill snapshot is unavailable.');
    }

    const loading = this.load(key, load);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        loading,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Skill snapshot is still loading.')),
            this.coldWaitMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // The load outlives a caller that stopped waiting for it.
      loading.catch(() => undefined);
    }
  }

  private load(
    key: string,
    load: () => Promise<TSnapshot>,
  ): Promise<TSnapshot> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const loading = (async () => {
      try {
        const loaded = await load();
        await this.cleanup(loaded).catch(() => undefined);
        const snapshot = this.retain(loaded);
        this.retryAt.delete(key);
        this.entries.delete(key);
        this.entries.set(key, { loadedAt: this.now(), snapshot });
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return snapshot;
      } catch (error) {
        this.retryAt.set(key, this.now() + this.retryMs);
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, loading);
    return loading;
  }
}
