/**
 * The Slack collector against a fake Slack.
 *
 * Every other test here mocks `collect()` at the collector boundary, which
 * means the function where this collector's bugs actually live never runs.
 * All of them have been interactions rather than single mistakes: a page
 * ceiling meeting a time window, a day-boundary cap meeting a watermark, an
 * error path meeting an advance. Each limit was correct alone and tested
 * alone, which is exactly why the tests kept passing.
 *
 * So this drives the real collector against a Slack that behaves like the
 * real one (newest-first, oldest/latest filtering, cursor paging), and asserts
 * a property over many ticks rather than a scenario: everything posted inside
 * the window is ingested exactly once, and the watermark keeps moving. A new
 * limit that conflicts with an existing one breaks that property without
 * anyone having to predict the conflict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeMessage = { ts: string; text: string; user: string };
type FakeChannel = { id: string; name: string; messages: FakeMessage[] };

const workspace = vi.hoisted(() => ({
  channels: [] as FakeChannel[],
  /** Channel ids whose next history read throws, to exercise failure paths. */
  failing: new Set<string>(),
  historyCalls: 0,
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    db: {
      select: () => ({
        from: () => ({
          where: async () => [
            { teamId: 'T1', botAccessToken: 'xoxb-test', isActive: true },
          ],
        }),
      }),
      query: {
        slackInstallations: { findFirst: async () => ({ id: 'i1' }) },
        mcpConnections: { findFirst: async () => null },
      },
    },
  };
});

vi.mock('@roomote/slack', () => ({
  createSlackWebClient: () => ({
    conversations: {
      list: async () => ({
        channels: workspace.channels.map((c) => ({
          id: c.id,
          name: c.name,
          is_member: true,
          is_private: false,
        })),
      }),
      /**
       * Slack's real contract, which is what makes this worth having:
       * results are newest-first, `oldest`/`latest` bound the range, `limit`
       * truncates, and `next_cursor` walks toward older messages.
       */
      history: async ({
        channel,
        limit,
        oldest,
        latest,
        cursor,
      }: {
        channel: string;
        limit: number;
        oldest?: string;
        latest?: string;
        cursor?: string;
      }) => {
        workspace.historyCalls++;

        if (workspace.failing.has(channel)) {
          throw new Error('slack is having a moment');
        }

        const found = workspace.channels.find((c) => c.id === channel);
        const inRange = (found?.messages ?? [])
          .filter((m) => {
            const ts = Number(m.ts);
            return (
              (!oldest || ts > Number(oldest)) &&
              (!latest || ts <= Number(latest))
            );
          })
          .sort((a, b) => Number(b.ts) - Number(a.ts));

        const start = cursor ? Number(cursor) : 0;
        const page = inRange.slice(start, start + limit);
        const nextStart = start + limit;

        return {
          messages: page,
          response_metadata:
            nextStart < inRange.length
              ? { next_cursor: String(nextStart) }
              : {},
        };
      },
    },
  }),
}));

const { slackPublicChannelsCollector } = await import('../brain-collectors');

const DAY_MS = 24 * 60 * 60 * 1000;

function seedChannel(
  id: string,
  name: string,
  count: number,
  spanMs: number,
  endMs: number,
): FakeChannel {
  const messages: FakeMessage[] = [];

  for (let i = 0; i < count; i++) {
    // Spread evenly across the span, oldest first.
    const at = endMs - spanMs + Math.floor((spanMs * i) / Math.max(count, 1));
    messages.push({
      ts: (at / 1000).toFixed(6),
      text: `${id} message ${i}`,
      user: 'U1',
    });
  }

  return { id, name, messages };
}

/**
 * Run the collector until it stops advancing, exactly as the engine does, and
 * return every message body that made it into a page.
 */
async function drainToCaughtUp(from: Date | null = null, maxTicks = 60) {
  let since: Date | null = from;
  const ingested = new Set<string>();
  let ticks = 0;

  for (; ticks < maxTicks; ticks++) {
    const result = await slackPublicChannelsCollector.collect({
      since,
      now: new Date(),
      limit: 100,
    });

    for (const page of result.pages) {
      for (const line of page.content.split('\n')) {
        const match = line.match(/: (C\d+ message \d+)$/);
        if (match?.[1]) ingested.add(match[1]);
      }
    }

    if (!result.nextSince) break;
    if (since && result.nextSince.getTime() <= since.getTime()) break;

    since = result.nextSince;
  }

  return { ingested, since, ticks };
}

beforeEach(() => {
  workspace.channels = [];
  workspace.failing.clear();
  workspace.historyCalls = 0;
});

describe('slack collector against a fake Slack', () => {
  it('ingests every message in a quiet workspace and advances', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'general', 20, 2 * DAY_MS, now),
      seedChannel('C2', 'ops', 5, 2 * DAY_MS, now),
    ];

    const { ingested, since } = await drainToCaughtUp(
      new Date(now - 3 * DAY_MS),
    );

    expect(ingested.size).toBe(25);
    expect(since).not.toBeNull();
  });

  it('loses nothing in a channel far busier than one page', async () => {
    // The original bug: one page of a newest-first read, then the watermark
    // jumps past everything older in the same window.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'busy', 900, 3 * DAY_MS, now)];

    const { ingested } = await drainToCaughtUp(new Date(now - 4 * DAY_MS));

    expect(ingested.size).toBe(900);
  });

  it('catches up across a long backlog without stalling', async () => {
    // Watermark far behind, so the time-sliced window has to walk forward
    // repeatedly rather than either skipping or spinning.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'history', 400, 10 * DAY_MS, now)];

    const { ingested, ticks } = await drainToCaughtUp(
      new Date(now - 11 * DAY_MS),
    );

    expect(ingested.size).toBe(400);
    // It should take several passes, and still terminate well short of the cap.
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBeLessThan(60);
  });

  it('holds the watermark when a channel cannot be read', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'fine', 10, DAY_MS, now),
      seedChannel('C2', 'broken', 10, DAY_MS, now),
    ];
    workspace.failing.add('C2');

    const first = await slackPublicChannelsCollector.collect({
      since: new Date(now - 2 * DAY_MS),
      now: new Date(),
      limit: 100,
    });

    // A channel we could not read leaves a hole, so the pass must not move on.
    expect(first.nextSince).toBeNull();
  });

  it('recovers the unread window once the failure clears', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'fine', 10, DAY_MS, now),
      seedChannel('C2', 'flaky', 10, DAY_MS, now),
    ];
    workspace.failing.add('C2');

    await slackPublicChannelsCollector.collect({
      since: new Date(now - 2 * DAY_MS),
      now: new Date(),
      limit: 100,
    });

    workspace.failing.clear();
    const { ingested } = await drainToCaughtUp(new Date(now - 2 * DAY_MS));

    // Nothing was skipped by the earlier failure.
    expect(ingested.size).toBe(20);
  });

  it('does not advance past now when the watermark is already current', async () => {
    // The window floor once pushed the watermark into the future, which would
    // skip whatever was posted in the gap on every steady-state tick.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'general', 3, 60 * 1000, now)];

    const result = await slackPublicChannelsCollector.collect({
      since: new Date(now - 60 * 1000),
      now: new Date(),
      limit: 100,
    });

    if (result.nextSince) {
      expect(result.nextSince.getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it('re-reading the same window changes nothing', async () => {
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'general', 40, DAY_MS, now)];

    const first = await drainToCaughtUp(new Date(now - 2 * DAY_MS));
    const callsAfterFirst = workspace.historyCalls;
    const second = await drainToCaughtUp(new Date(now - 2 * DAY_MS));

    expect(second.ingested).toEqual(first.ingested);
    expect(workspace.historyCalls).toBeGreaterThan(callsAfterFirst);
  });
});
