import type { CommandOutputEvent } from './types';

const DEFAULT_MAX_CHARS = 256 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_FLUSH_SIZE = 16 * 1024;

export type CommandOutputTranscriptStream =
  | CommandOutputEvent['stream']
  | 'command';

export interface CommandOutputTranscriptRecorder {
  append(
    stream: CommandOutputTranscriptStream,
    data: string,
    timestamp?: Date,
  ): Promise<void>;
  flush(): Promise<void>;
}

export function createCommandOutputTranscriptRecorder(options: {
  write: (entries: string, maxChars: number) => Promise<void>;
  onWriteError?: (error: unknown) => void;
  maxChars?: number;
  flushIntervalMs?: number;
  flushSize?: number;
  clock?: () => Date;
}): CommandOutputTranscriptRecorder {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
  const clock = options.clock ?? (() => new Date());
  let writes = Promise.resolve();
  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }

    if (!buffer) return writes;

    const entries = buffer;
    buffer = '';
    writes = writes
      .then(() => options.write(entries, maxChars))
      .catch((error: unknown) => options.onWriteError?.(error));
    return writes;
  };

  const append = (
    stream: CommandOutputTranscriptStream,
    data: string,
    timestamp = clock(),
  ): Promise<void> => {
    const prefix = `[${timestamp.toISOString()}] [${stream}] `;
    const sanitized = data.replaceAll('\0', '');
    const suffix = sanitized.endsWith('\n') ? '' : '\n';
    const available = maxChars - prefix.length - suffix.length;
    const retained =
      sanitized.length > available ? sanitized.slice(-available) : sanitized;
    buffer += `${prefix}${retained}${suffix}`;

    if (buffer.length > maxChars) buffer = buffer.slice(-maxChars);

    if (stream === 'command' || buffer.length >= flushSize) return flush();

    flushTimer ??= setTimeout(() => void flush(), flushIntervalMs);
    flushTimer.unref?.();
    return writes;
  };

  return { append, flush };
}
