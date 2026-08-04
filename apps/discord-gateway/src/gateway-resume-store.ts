import { createHash } from 'node:crypto';

import type { SessionInfo } from '@discordjs/ws';
import {
  clearDiscordGatewayResumeState,
  findDiscordGatewayResumeState,
  recordDiscordGatewayHeartbeatAck,
  saveDiscordGatewayResumeState,
  updateDiscordGatewaySequence,
  type DiscordGatewaySessionKey,
} from '@roomote/sdk/server/discord-persistence';

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const MAX_UNCHECKPOINTED_DISPATCHES_PER_SHARD = 1_000;

type DiscordGatewayResumeRepository = {
  find: typeof findDiscordGatewayResumeState;
  save: typeof saveDiscordGatewayResumeState;
  updateSequence: typeof updateDiscordGatewaySequence;
  clear: typeof clearDiscordGatewayResumeState;
  recordHeartbeat: typeof recordDiscordGatewayHeartbeatAck;
};

const defaultRepository: DiscordGatewayResumeRepository = {
  find: findDiscordGatewayResumeState,
  save: saveDiscordGatewayResumeState,
  updateSequence: updateDiscordGatewaySequence,
  clear: clearDiscordGatewayResumeState,
  recordHeartbeat: recordDiscordGatewayHeartbeatAck,
};

/**
 * Implements @discordjs/ws's public session persistence callbacks. Sequence
 * writes are coalesced so ordinary Gateway traffic does not turn into one
 * database write per dispatch. @discordjs/ws reports its latest observed
 * sequence before the dispatch handler has made that event durable, so resume
 * reads deliberately expose only the latest contiguous acknowledged
 * checkpoint. An older durable sequence only causes Discord to replay events.
 */
export class DiscordGatewayResumeStore {
  private readonly sessions = new Map<number, SessionInfo | null>();
  private readonly loadedShards = new Set<number>();
  private readonly durableSequences = new Map<number, number>();
  private readonly acknowledgedSequences = new Map<number, Set<number>>();
  private readonly pendingSequences = new Map<number, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<void> | null = null;
  private preserveSessionClears = false;

  constructor(
    private readonly tokenFingerprint: string,
    private readonly repository: DiscordGatewayResumeRepository = defaultRepository,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  ) {}

  private key(shardId: number): DiscordGatewaySessionKey {
    return { tokenFingerprint: this.tokenFingerprint, shardId };
  }

  async retrieve(shardId: number): Promise<SessionInfo | null> {
    if (this.loadedShards.has(shardId)) {
      return this.committedSession(shardId);
    }

    const persisted = await this.repository.find(this.key(shardId));
    const session = persisted
      ? {
          sessionId: persisted.sessionId,
          resumeURL: persisted.resumeGatewayUrl,
          sequence: persisted.sequence,
          shardId: persisted.shardId,
          shardCount: persisted.shardCount,
        }
      : null;
    this.loadedShards.add(shardId);
    this.sessions.set(shardId, session);
    if (session) {
      this.durableSequences.set(shardId, session.sequence);
    }
    return this.committedSession(shardId);
  }

  getSessionDedupeScope(shardId: number): string | undefined {
    const sessionId = this.sessions.get(shardId)?.sessionId;
    if (!sessionId) return undefined;

    return createHash('sha256')
      .update(`${this.tokenFingerprint}:${sessionId}`)
      .digest('hex')
      .slice(0, 16);
  }

  async update(shardId: number, session: SessionInfo | null): Promise<void> {
    const previous = this.sessions.get(shardId) ?? null;
    this.loadedShards.add(shardId);
    this.sessions.set(shardId, session);

    if (!session) {
      this.pendingSequences.delete(shardId);
      this.durableSequences.delete(shardId);
      this.acknowledgedSequences.delete(shardId);
      if (!this.preserveSessionClears) {
        await this.repository.clear(this.key(shardId));
      }
      return;
    }

    if (
      !previous ||
      previous.sessionId !== session.sessionId ||
      previous.resumeURL !== session.resumeURL ||
      previous.shardCount !== session.shardCount
    ) {
      this.pendingSequences.delete(shardId);
      this.acknowledgedSequences.delete(shardId);
      await this.repository.save({
        ...this.key(shardId),
        sessionId: session.sessionId,
        resumeGatewayUrl: session.resumeURL,
        sequence: session.sequence,
        shardCount: session.shardCount,
      });
      this.durableSequences.set(shardId, session.sequence);
      return;
    }
  }

  /**
   * Mark a dispatch safe to include in the durable resume checkpoint. Callers
   * do this only after the event has reached the durable inbound queue or has
   * been deliberately ignored.
   */
  acknowledgeDispatch(shardId: number, sequence: number): boolean {
    const observedSession = this.sessions.get(shardId);
    if (!observedSession || !Number.isSafeInteger(sequence)) return false;

    const acknowledgedSequence = Math.min(sequence, observedSession.sequence);
    const durableSequence = this.durableSequences.get(shardId) ?? -1;
    const pendingSequence = this.pendingSequences.get(shardId) ?? -1;
    const checkpointSequence = Math.max(durableSequence, pendingSequence);
    if (acknowledgedSequence <= checkpointSequence) {
      return true;
    }

    const acknowledgements =
      this.acknowledgedSequences.get(shardId) ?? new Set<number>();
    if (
      acknowledgements.size >= MAX_UNCHECKPOINTED_DISPATCHES_PER_SHARD &&
      !acknowledgements.has(acknowledgedSequence)
    ) {
      return false;
    }
    acknowledgements.add(acknowledgedSequence);
    this.acknowledgedSequences.set(shardId, acknowledgements);

    let contiguousSequence = checkpointSequence;
    while (acknowledgements.delete(contiguousSequence + 1)) {
      contiguousSequence += 1;
    }
    if (contiguousSequence === checkpointSequence) {
      return true;
    }

    this.pendingSequences.set(shardId, contiguousSequence);
    this.scheduleFlush();
    return true;
  }

  async recordHeartbeat(shardId: number, acknowledgedAt: Date): Promise<void> {
    await this.repository.recordHeartbeat({
      ...this.key(shardId),
      acknowledgedAt,
    });
  }

  beginSessionHandoff(): void {
    this.preserveSessionClears = true;
  }

  endSessionHandoff(): void {
    this.preserveSessionClears = false;
  }

  async flush(): Promise<void> {
    if (this.activeFlush) {
      await this.activeFlush;
      if (this.pendingSequences.size > 0) {
        await this.flush();
      }
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingSequences.size === 0) {
      return;
    }

    const pending = [...this.pendingSequences.entries()];
    this.pendingSequences.clear();
    this.activeFlush = Promise.all(
      pending.map(([shardId, sequence]) =>
        this.repository.updateSequence({
          ...this.key(shardId),
          sequence,
        }),
      ),
    ).then(() => undefined);

    try {
      await this.activeFlush;
      for (const [shardId, sequence] of pending) {
        this.durableSequences.set(
          shardId,
          Math.max(sequence, this.durableSequences.get(shardId) ?? sequence),
        );
      }
    } catch (error) {
      for (const [shardId, sequence] of pending) {
        const newerSequence = this.pendingSequences.get(shardId);
        this.pendingSequences.set(
          shardId,
          Math.max(sequence, newerSequence ?? sequence),
        );
      }
      throw error;
    } finally {
      this.activeFlush = null;
    }

    if (this.pendingSequences.size > 0) {
      await this.flush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => {
        console.error(
          `[discord-gateway] failed to persist Gateway resume sequence: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.scheduleFlush();
      });
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  /**
   * Keep the freshest session identity while withholding any sequence that
   * has merely been observed on the socket. Pending sequences are safe here:
   * they are contiguous dispatches whose queue writes already completed, even
   * if their coalesced database write has not run yet.
   */
  private committedSession(shardId: number): SessionInfo | null {
    const observed = this.sessions.get(shardId);
    if (!observed) return null;

    const durableSequence = this.durableSequences.get(shardId);
    const pendingSequence = this.pendingSequences.get(shardId);
    const committedSequence =
      durableSequence === undefined
        ? pendingSequence
        : pendingSequence === undefined
          ? durableSequence
          : Math.max(durableSequence, pendingSequence);
    if (committedSequence === undefined) return null;

    return {
      ...observed,
      sequence: Math.min(observed.sequence, committedSequence),
    };
  }
}
