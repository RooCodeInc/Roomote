import { z } from 'zod';

/** Bound the replay used when no page watermark is available or a connection
 * resumes much later. Initial session pages normally provide a fresher cursor. */
const INITIAL_CURSOR_OVERLAP_MS = 60_000;

const cursorSchema = z.coerce.number().finite().nonnegative();

function parseCursor(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = cursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Pick the transcript cursor a Session stream connection starts from.
 *
 * Every stream event carries the cursor as its SSE event id, so a browser
 * auto-reconnect sends it back as `Last-Event-ID`. That is an exact resume
 * point, so it is used as-is: rows persisted during a long network or sleep
 * gap still stream. The `since` page watermark on the URL never advances, so
 * it is only trusted within the recent overlap window.
 */
export function resolveFastSessionStreamCursor({
  lastEventId,
  since,
  nowMs,
}: {
  lastEventId: string | null | undefined;
  since: string | null | undefined;
  nowMs: number;
}): number {
  const resumeCursor = parseCursor(lastEventId);
  if (resumeCursor !== null) return resumeCursor;

  const fallbackCursor = nowMs - INITIAL_CURSOR_OVERLAP_MS;
  const sinceCursor = parseCursor(since);
  return sinceCursor === null
    ? fallbackCursor
    : Math.max(sinceCursor, fallbackCursor);
}
