import { describe, expect, it } from 'vitest';

import {
  groupSlackMessagesIntoDayPages,
  type SlackChannelMessage,
} from '../brain-collectors/slack-public-channels';

describe('groupSlackMessagesIntoDayPages', () => {
  // 2026-08-13T14:03:20Z and 2026-08-14T09:10:00Z respectively.
  const day1Ts = String(Date.UTC(2026, 7, 13, 14, 3, 20) / 1000);
  const day1LaterTs = String(Date.UTC(2026, 7, 13, 15, 30, 0) / 1000);
  const day2Ts = String(Date.UTC(2026, 7, 14, 9, 10, 0) / 1000);

  it('groups a batch into immutable channel/day chunks', () => {
    const messages: SlackChannelMessage[] = [
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1LaterTs,
        userId: 'U2',
        text: 'second message',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        userLabel: 'Alice Example',
        text: 'first message',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day2Ts,
        userId: 'U1',
        text: 'next day',
      },
      {
        teamId: 'T1',
        channelId: 'C2',
        channelName: 'ops',
        ts: day1Ts,
        userId: null,
        text: 'ops message',
      },
    ];

    const pages = groupSlackMessagesIntoDayPages(messages);

    // Oldest day first, then workspace and channel for deterministic writes.
    expect(pages.map((page) => page.slug)).toEqual([
      `slack/t1/c1/2026-08-13/${day1Ts}-${day1LaterTs}`.replaceAll('.', '-'),
      `slack/t1/c2/2026-08-13/${day1Ts}-${day1Ts}`.replaceAll('.', '-'),
      `slack/t1/c1/2026-08-14/${day2Ts}-${day2Ts}`.replaceAll('.', '-'),
    ]);
    expect(pages[0]?.title).toBe('#general — 2026-08-13');
    // The title must also lead the content as a markdown heading: put_page
    // carries no title field, and gbrain derives a page's title from the
    // first heading — without it the slug's timestamp range becomes the
    // title on every surface.
    // type/title/created are the fields gbrain's lint requires on every
    // page; without `type` gbrain files the page as a generic concept.
    expect(pages[0]?.content).toMatch(
      /^---\ntype: slack\ntitle: "#general — 2026-08-13"\ncreated: 2026-08-13\ndate: 2026-08-13\n---\n\n# #general — 2026-08-13\n/,
    );
    expect(pages[2]?.content).toMatch(
      /^---\ntype: slack\ntitle: "#general — 2026-08-14"\ncreated: 2026-08-14\ndate: 2026-08-14\n---\n\n# #general — 2026-08-14\n/,
    );
    expect(pages[0]?.content).toContain(
      'Slack public channel #general (C1), messages on 2026-08-13',
    );

    // Chronological order within the page despite reversed input order.
    const firstIndex = pages[0]?.content.indexOf('first message') ?? -1;
    const secondIndex = pages[0]?.content.indexOf('second message') ?? -1;
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(pages[0]?.content).toContain(
      '- [14:03] <Alice Example (U1)>: first message',
    );
    expect(pages[1]?.content).toContain('<unknown>: ops message');
  });

  it('drops empty and unparsable messages', () => {
    const pages = groupSlackMessagesIntoDayPages([
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: 'not-a-ts',
        userId: 'U1',
        text: 'bad ts',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        text: '   ',
      },
    ]);

    expect(pages).toEqual([]);
  });

  it('links canonical authors and emits stable timeline evidence', () => {
    const person = {
      slug: 'people/roomote-member-abc',
      title: 'Alice Example',
    };
    const pages = groupSlackMessagesIntoDayPages([
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        person,
        text: 'first decision',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1LaterTs,
        userId: 'U1',
        person,
        text: 'follow-up',
      },
    ]);

    expect(pages[0]?.content).toContain(
      '[Alice Example](people/roomote-member-abc) (U1): first decision',
    );
    expect(pages[0]?.timelineEvidence).toEqual([
      {
        slug: 'people/roomote-member-abc',
        date: '2026-08-13',
        summary: 'Participated in a public Slack channel',
        source: 'slack:channel-day:T1/C1/2026-08-13',
      },
    ]);
    expect(
      groupSlackMessagesIntoDayPages([
        {
          teamId: 'T1',
          channelId: 'C1',
          channelName: 'general',
          ts: day1Ts,
          userId: 'U1',
          person,
          text: 'first decision',
        },
        {
          teamId: 'T1',
          channelId: 'C1',
          channelName: 'general',
          ts: day1LaterTs,
          userId: 'U1',
          person,
          text: 'follow-up',
        },
      ])[0]?.timelineEvidence,
    ).toEqual(pages[0]?.timelineEvidence);
  });

  it('keeps timeline evidence stable across Slack batches, edits, and channel renames', () => {
    const person = {
      slug: 'people/roomote-member-abc',
      title: 'Alice Example',
    };
    const firstBatch = groupSlackMessagesIntoDayPages([
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        person,
        text: 'original message',
      },
    ]);
    const laterBatch = groupSlackMessagesIntoDayPages([
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'renamed-channel',
        ts: day1LaterTs,
        userId: 'U1',
        person,
        text: 'edited or later message',
      },
    ]);

    expect(firstBatch[0]?.slug).not.toBe(laterBatch[0]?.slug);
    expect(laterBatch[0]?.timelineEvidence).toEqual(
      firstBatch[0]?.timelineEvidence,
    );
    expect(laterBatch[0]?.timelineEvidence?.[0]).not.toHaveProperty('detail');
  });
});
