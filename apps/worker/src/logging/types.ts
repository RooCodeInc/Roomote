export type HarnessLogger = Pick<Console, 'log' | 'info' | 'warn' | 'error'> & {
  cloudJobId: number;
  filePath: string;
  flush?: () => Promise<void>;
};

type LogMethods = Pick<Console, 'log' | 'info' | 'warn' | 'error'>;

type WorkerLogLevel = keyof LogMethods;

export interface WorkerLogEntry {
  timestamp: string;
  logger: 'startup' | 'harness';
  level: WorkerLogLevel;
  message: string;
  channel?: 'user' | 'debug';
  cloudJobId?: number;
  filePath?: string;
}

export interface WorkerLogSink {
  write(entry: WorkerLogEntry): void;
  flush?(): Promise<void>;
}

/**
 * Logger for the worker startup phase that separates user-facing output from
 * internal debug messages.
 *
 * Both channels write to stdout so all output is captured in the Vercel
 * Sandbox log pipeline. The Startup UI filters lines prefixed with `[debug]`
 * to show only curated, user-facing messages.
 *
 * - `userLog` – plain stdout, shown in the Startup UI.
 * - `debug` – prefixed with `[debug]`, filtered out by the UI but visible
 *   in raw sandbox logs for developer inspection.
 */
export interface StartupLogger {
  /** Curated, user-facing messages visible in the Startup UI (stdout). */
  userLog: LogMethods;
  /** Internal operational messages, prefixed with `[debug]` (stdout, filtered by UI). */
  debug: LogMethods;
  /**
   * Start persisting all log output (past and future) to the given file path.
   * Buffered messages written before this call are flushed immediately.
   */
  setFilePath: (filePath: string) => void;
}
