import type {
  AcpMessage,
  AcpPersistedEnvelope,
  AcpTurnCompletedEvent,
  TaskEvent,
} from '@roomote/types';
import { ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL } from '@roomote/types';

/**
 * Event sink for Roomote runtime envelopes.
 *
 * Keeping the bus shape here lets the direct runtime plug its EventEmitter in
 * behind the builder without leaking event-emitter typing concerns into the
 * shared plumbing.
 */
interface RuntimeEnvelopeBus {
  taskEvent: (event: TaskEvent) => void;
  runtimeOutput: (event: AcpMessage) => void;
  runtimePersistedEnvelope: (envelope: AcpPersistedEnvelope) => void;
  runtimeTurnCompleted: (event: AcpTurnCompletedEvent) => void;
}

export type PersistableEnvelope = Omit<AcpPersistedEnvelope, 'protocol'> & {
  visibleInTranscript?: boolean;
};

/**
 * Shared plumbing for Roomote runtime events: owns the monotonic `ts` sequence
 * and protocol stamping on persisted envelopes and turn-completed events.
 * Semantic envelope factories (userPrompt, assistantMessage, etc.) remain
 * runtime-specific because this base class only handles the pieces that are
 * genuinely shared.
 */
export class RuntimeEnvelopeBuilder {
  private lastMessageTs = 0;

  constructor(private readonly bus: RuntimeEnvelopeBus) {}

  /**
   * Monotonic timestamp used to order every emitted envelope. Guaranteed to
   * advance by at least 1 between calls even if `Date.now()` does not.
   */
  nextTs(): number {
    const now = Date.now();
    const next = Math.max(now, this.lastMessageTs + 1);
    this.lastMessageTs = next;
    return next;
  }

  emitOutput(event: AcpMessage): void {
    this.bus.runtimeOutput(event);
  }

  emitPersisted(envelope: PersistableEnvelope): void {
    this.bus.runtimePersistedEnvelope({
      ...envelope,
      contentBlocks: envelope.contentBlocks ?? [],
      metadata: envelope.metadata ?? null,
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    } satisfies AcpPersistedEnvelope);
  }

  emitTurnCompleted(event: Omit<AcpTurnCompletedEvent, 'protocol'>): void {
    this.bus.runtimeTurnCompleted({
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      ...event,
    } satisfies AcpTurnCompletedEvent);
  }

  emitTaskEvent(event: TaskEvent): void {
    this.bus.taskEvent(event);
  }
}
