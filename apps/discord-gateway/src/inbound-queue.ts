import type { Redis } from '@roomote/redis';

export const DISCORD_INBOUND_STREAM_KEY = 'discord:gateway:inbound';
export const DISCORD_INBOUND_ATTEMPTS_KEY = 'discord:gateway:inbound:attempts';
export const DISCORD_DEAD_LETTER_STREAM_KEY =
  'discord:gateway:inbound:dead-letter';
const DEDUPE_PREFIX = 'discord:gateway:dedupe';
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_INBOUND_MAX_ENTRIES = 50_000;
const DEFAULT_DEAD_LETTER_MAX_ENTRIES = 1_000;

const ENQUEUE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return false
end
local streamId = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*', 'envelope', ARGV[2])
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
return streamId
`;

const ACKNOWLEDGE_SCRIPT = `
local deleted = redis.call('XDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return deleted
`;

const QUARANTINE_SCRIPT = `
local existing = redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1], 'COUNT', 1)
if #existing == 0 then
  redis.call('HDEL', KEYS[3], ARGV[1])
  return false
end
local deadLetterId = redis.call(
  'XADD', KEYS[2], 'MAXLEN', '~', ARGV[6], '*',
  'sourceStreamId', ARGV[1],
  'envelope', ARGV[2],
  'reason', ARGV[3],
  'attempts', ARGV[4],
  'quarantinedAt', ARGV[5]
)
redis.call('XDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
return deadLetterId
`;

export type DiscordInboundEventType = 'MESSAGE_CREATE' | 'INTERACTION_CREATE';

export type DiscordInboundEnvelope = {
  eventId: string;
  eventType: DiscordInboundEventType;
  payload: unknown;
  receivedAt: string;
  /** Try editing the interaction's original response before channel fallback. */
  interactionDeferred?: boolean;
};

type QueuedDiscordInboundEnvelope = {
  kind: 'event';
  streamId: string;
  envelope: DiscordInboundEnvelope;
  serializedEnvelope: string;
};

type MalformedDiscordInboundEntry = {
  kind: 'malformed';
  streamId: string;
  serializedEnvelope: string;
  reason: string;
};

type DiscordInboundQueueEntry =
  | QueuedDiscordInboundEnvelope
  | MalformedDiscordInboundEntry;

type DiscordInboundQueueOptions = {
  /**
   * Approximate cap on the durable inbound stream. During an extended
   * delivery outage the oldest undelivered events are shed once the cap is
   * exceeded — bounded memory is preferred over an unbounded Redis stream,
   * and the status store surfaces the pressure before shedding starts.
   */
  maxEntries?: number;
  /** Approximate cap on the dead-letter stream. */
  deadLetterMaxEntries?: number;
};

export class DiscordInboundQueue {
  private readonly maxEntries: number;
  private readonly deadLetterMaxEntries: number;

  constructor(
    private readonly redis: Redis,
    options: DiscordInboundQueueOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_INBOUND_MAX_ENTRIES;
    this.deadLetterMaxEntries =
      options.deadLetterMaxEntries ?? DEFAULT_DEAD_LETTER_MAX_ENTRIES;
  }

  /** Approximate inbound stream cap, for capacity-pressure reporting. */
  get capacity(): number {
    return this.maxEntries;
  }

  async enqueue(envelope: DiscordInboundEnvelope): Promise<boolean> {
    const dedupeKey = `${DEDUPE_PREFIX}:${envelope.eventType}:${envelope.eventId}`;
    const result = await this.redis.eval(
      ENQUEUE_SCRIPT,
      2,
      dedupeKey,
      DISCORD_INBOUND_STREAM_KEY,
      DEDUPE_TTL_SECONDS.toString(),
      JSON.stringify(envelope),
      this.maxEntries.toString(),
    );

    return typeof result === 'string';
  }

  async peek(limit = 25): Promise<DiscordInboundQueueEntry[]> {
    const entries = await this.redis.xrange(
      DISCORD_INBOUND_STREAM_KEY,
      '-',
      '+',
      'COUNT',
      limit,
    );

    return entries.map(([streamId, fields]) => {
      const envelopeIndex = fields.indexOf('envelope');
      const serialized =
        envelopeIndex >= 0 ? fields[envelopeIndex + 1] : undefined;

      if (envelopeIndex < 0 || !serialized) {
        return {
          kind: 'malformed' as const,
          streamId,
          serializedEnvelope: serialized ?? '',
          reason: 'Stream entry is missing its envelope field',
        };
      }

      try {
        return {
          kind: 'event' as const,
          streamId,
          envelope: JSON.parse(serialized) as DiscordInboundEnvelope,
          serializedEnvelope: serialized,
        };
      } catch (error) {
        return {
          kind: 'malformed' as const,
          streamId,
          serializedEnvelope: serialized,
          reason: `Envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  async acknowledge(streamId: string): Promise<void> {
    await this.redis.eval(
      ACKNOWLEDGE_SCRIPT,
      2,
      DISCORD_INBOUND_STREAM_KEY,
      DISCORD_INBOUND_ATTEMPTS_KEY,
      streamId,
    );
  }

  async recordAttempt(streamId: string): Promise<number> {
    return this.redis.hincrby(DISCORD_INBOUND_ATTEMPTS_KEY, streamId, 1);
  }

  async quarantine(input: {
    streamId: string;
    serializedEnvelope: string;
    reason: string;
    attempts: number;
    quarantinedAt?: Date;
  }): Promise<boolean> {
    const result = await this.redis.eval(
      QUARANTINE_SCRIPT,
      3,
      DISCORD_INBOUND_STREAM_KEY,
      DISCORD_DEAD_LETTER_STREAM_KEY,
      DISCORD_INBOUND_ATTEMPTS_KEY,
      input.streamId,
      input.serializedEnvelope,
      input.reason.slice(0, 1_000),
      input.attempts.toString(),
      (input.quarantinedAt ?? new Date()).toISOString(),
      this.deadLetterMaxEntries.toString(),
    );
    return typeof result === 'string';
  }

  async depth(): Promise<number> {
    return this.redis.xlen(DISCORD_INBOUND_STREAM_KEY);
  }

  async deadLetterDepth(): Promise<number> {
    return this.redis.xlen(DISCORD_DEAD_LETTER_STREAM_KEY);
  }
}
