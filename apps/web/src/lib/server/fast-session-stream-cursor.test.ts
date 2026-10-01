import { describe, expect, it } from 'vitest';

import { resolveFastSessionStreamCursor } from './fast-session-stream-cursor';

const nowMs = 1_800_000_000_000;

describe('resolveFastSessionStreamCursor', () => {
  it('falls back to the recent overlap window without a cursor', () => {
    expect(
      resolveFastSessionStreamCursor({
        lastEventId: null,
        since: null,
        nowMs,
      }),
    ).toBe(nowMs - 60_000);
  });

  it('uses a fresh page watermark', () => {
    expect(
      resolveFastSessionStreamCursor({
        lastEventId: null,
        since: String(nowMs - 5_000.25),
        nowMs,
      }),
    ).toBe(nowMs - 5_000.25);
  });

  it('clamps a stale page watermark to the overlap window', () => {
    expect(
      resolveFastSessionStreamCursor({
        lastEventId: null,
        since: String(nowMs - 3_600_000),
        nowMs,
      }),
    ).toBe(nowMs - 60_000);
  });

  it('resumes from Last-Event-ID after a long gap', () => {
    const resumeCursor = nowMs - 10 * 60_000 + 0.5;
    expect(
      resolveFastSessionStreamCursor({
        lastEventId: String(resumeCursor),
        since: String(nowMs - 3_600_000),
        nowMs,
      }),
    ).toBe(resumeCursor);
  });

  it('ignores a non-numeric Last-Event-ID', () => {
    expect(
      resolveFastSessionStreamCursor({
        lastEventId: '0b6f7c1e-7a51-4c1b-9d2e-1f7b0f4f6a11',
        since: null,
        nowMs,
      }),
    ).toBe(nowMs - 60_000);
  });
});
