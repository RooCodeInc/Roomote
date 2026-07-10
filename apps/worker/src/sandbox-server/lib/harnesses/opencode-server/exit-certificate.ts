import { readFileSync } from 'node:fs';

// Death certificate for the OpenCode server subprocess. The sandbox and its
// logs are gone by the time anyone investigates, so the facts that identify
// the killer are collected while the process runs and handed to the caller
// the moment it exits: exit code and signal (137 = killed for memory), the
// last output lines, uptime, and a sandbox memory reading taken just after
// the exit. Collection is bounded: a fixed-size line ring with per-line caps,
// so the cost per output line is constant regardless of how chatty the
// process is.
const MAX_TAIL_LINES = 50;
const MAX_LINE_CHARS = 300;

export interface OpenCodeExitCertificate {
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
  outputTail: string[];
  // Sandbox-wide memory observed just after the exit — by then the kernel has
  // reclaimed the dead process's pages, so an OOM kill can already look
  // recovered here; the exit code/signal is the authoritative OOM signal.
  // workerRssBytes is the surviving sandbox-server process, not the victim.
  memoryAfterExit: {
    memTotalKb: number;
    memAvailableKb: number;
    workerRssBytes: number;
  } | null;
}

function readMemorySnapshot(): OpenCodeExitCertificate['memoryAfterExit'] {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const readKb = (field: string): number | null => {
      const match = meminfo.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'));
      return match?.[1] ? Number.parseInt(match[1], 10) : null;
    };
    const memTotalKb = readKb('MemTotal');
    const memAvailableKb = readKb('MemAvailable');

    if (memTotalKb === null || memAvailableKb === null) {
      return null;
    }

    return {
      memTotalKb,
      memAvailableKb,
      workerRssBytes: process.memoryUsage().rss,
    };
  } catch {
    return null;
  }
}

export function createOpenCodeExitCertificateCollector(): {
  appendLine(stream: 'stdout' | 'stderr', line: string): void;
  build(input: {
    exitCode: number | null;
    signal: string | null;
  }): OpenCodeExitCertificate;
} {
  const startedAtMs = Date.now();
  const tail: string[] = [];

  return {
    appendLine(stream, line) {
      const trimmed = line.trim();

      if (!trimmed) {
        return;
      }

      const capped =
        trimmed.length > MAX_LINE_CHARS
          ? `${trimmed.slice(0, MAX_LINE_CHARS)}…`
          : trimmed;

      tail.push(`[${stream}] ${capped}`);
      if (tail.length > MAX_TAIL_LINES) {
        tail.shift();
      }
    },
    build(input) {
      return {
        exitCode: input.exitCode,
        signal: input.signal,
        uptimeMs: Date.now() - startedAtMs,
        outputTail: [...tail],
        memoryAfterExit: readMemorySnapshot(),
      };
    },
  };
}
