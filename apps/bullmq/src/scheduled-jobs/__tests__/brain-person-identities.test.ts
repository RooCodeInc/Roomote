import { describe, expect, it } from 'vitest';

import {
  buildPersonIdentityLookup,
  buildPersonIdentityPage,
  selectPersonIdentityBatch,
} from '../brain-collectors/person-identities';
import {
  buildSlackDirectoryPersonPage,
  isSlackDirectoryRefreshDue,
  isSlackHumanProfile,
  slackDirectoryPageUserIds,
  slackDirectoryProfileFromApi,
  type SlackDirectoryProfile,
} from '../brain-collectors/slack-directory';
import type { PersonIdentityRecord } from '../brain-collectors/identity';

describe('person identity pages', () => {
  const record: PersonIdentityRecord = {
    userId: 'user-dan',
    name: 'Dan Riccio',
    email: 'dan@example.com',
    role: 'admin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    deletedAt: null,
    providers: [
      {
        provider: 'Slack',
        identifier: 'U08TMEM25CP',
        display: 'Dan Riccio',
        title: 'VP of Engineering',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        provider: 'GitHub',
        identifier: 'daniel-lxs',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ],
  };

  it('creates a stable person card with provider aliases but no email', () => {
    const page = buildPersonIdentityPage(record);
    const renamed = buildPersonIdentityPage({
      ...record,
      name: 'Daniel Riccio',
    });

    expect(page.slug).toBe(renamed.slug);
    expect(page.slug).toMatch(/^people\/roomote-member-[a-f0-9]{16}$/);
    expect(page.title).toBe('Dan Riccio');
    expect(page.content).toContain('type: person');
    expect(page.content).toContain('event_date: 2026-01-01');
    expect(page.content).toContain('job_title: "VP of Engineering"');
    expect(page.content).toContain('daniel-lxs');
    expect(page.content).toContain('U08TMEM25CP');
    expect(page.content).toContain(
      '- Slack: Dan Riccio (U08TMEM25CP) — VP of Engineering',
    );
    expect(page.content).toContain('Joined Roomote on 2026-01-01.');
    expect(page.content).not.toContain('dan@example.com');
  });

  it('scrubs embedded emails from names and provider values', () => {
    const page = buildPersonIdentityPage({
      ...record,
      name: 'Dan Riccio <dan@example.com>',
      providers: [
        ...record.providers,
        {
          provider: 'Source control',
          identifier: 'daniel-lxs <provider@example.com>',
          display: 'Dan R. (display@example.com)',
          updatedAt: record.updatedAt,
        },
      ],
    });

    expect(page.title).toBe('Dan Riccio');
    expect(page.content).toContain('Dan R. (daniel-lxs)');
    expect(page.content).not.toContain('@example.com');
  });

  it('uses email only as a private attendee-resolution hint', () => {
    const lookup = buildPersonIdentityLookup([record]);

    expect(lookup.get('dan riccio')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
    expect(lookup.get('daniel-lxs')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
    expect(lookup.get('dan@example.com')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
  });

  it('removes provider aliases when a member is deleted', () => {
    const page = buildPersonIdentityPage({
      ...record,
      deletedAt: new Date('2026-08-15T00:00:00Z'),
    });

    expect(page.content).toContain('status: deleted');
    expect(page.content).toContain('aliases: []');
    expect(page.content).not.toContain('U08TMEM25CP');
    expect(page.content).not.toContain('daniel-lxs');
  });

  it('normalizes Slack directory profiles and excludes bots and app users', () => {
    const profile = slackDirectoryProfileFromApi({
      teamId: 'TROOMOTE',
      teamName: 'Roomote',
      user: {
        id: 'UADA',
        name: 'ada',
        real_name: 'Ada Lovelace',
        updated: 1_786_817_600,
        profile: { display_name: 'Ada', title: 'Mathematician' },
      },
    });

    expect(profile).toMatchObject({
      displayName: 'Ada',
      realName: 'Ada Lovelace',
      title: 'Mathematician',
    });
    expect(profile && isSlackHumanProfile(profile, 'UROOMOTE')).toBe(true);
    expect(
      profile && isSlackHumanProfile({ ...profile, isBot: true }, 'UROOMOTE'),
    ).toBe(false);
    expect(
      profile &&
        isSlackHumanProfile({ ...profile, isAppUser: true }, 'UROOMOTE'),
    ).toBe(false);
  });

  it('keeps a Slack profile anchored before later profile updates', () => {
    const profile = slackDirectoryProfileFromApi({
      teamId: 'TROOMOTE',
      teamName: 'Roomote',
      firstKnownAt: new Date('2026-07-01T00:00:00Z'),
      observedAt: new Date('2026-09-01T00:00:00Z'),
      user: {
        id: 'UADA',
        updated: new Date('2026-08-15T00:00:00Z').getTime() / 1000,
      },
    });

    expect(profile?.firstKnownAt).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  it('scopes cached Slack profiles to the current API page', () => {
    expect(
      slackDirectoryPageUserIds([
        { id: ' U1 ' },
        { id: 'U2' },
        { id: 'U1' },
        {},
      ]),
    ).toEqual(['U1', 'U2']);
  });

  it('refreshes a newly connected Slack workspace immediately', () => {
    const now = new Date('2026-08-15T12:00:00Z');

    expect(isSlackDirectoryRefreshDue({ state: null, now })).toBe(true);
    expect(
      isSlackDirectoryRefreshDue({
        state: {
          watermark: new Date('2026-08-15T11:00:00Z'),
          backfillCursor: null,
        },
        now,
      }),
    ).toBe(false);
    expect(
      isSlackDirectoryRefreshDue({
        state: {
          watermark: new Date('2026-08-15T11:00:00Z'),
          backfillCursor: 'next-page',
        },
        now,
      }),
    ).toBe(true);
  });

  it('builds standalone person cards for Slack members without Roomote accounts', () => {
    const profile: SlackDirectoryProfile = {
      slackUserId: 'UADA',
      slackTeamId: 'TROOMOTE',
      slackTeamName: 'Roomote',
      username: 'ada',
      displayName: 'Ada',
      realName: 'Ada Lovelace',
      title: 'Mathematician',
      isDeleted: false,
      isBot: false,
      isAppUser: false,
      profileUpdatedAt: new Date('2026-08-15T00:00:00Z'),
      firstKnownAt: new Date('2026-07-01T00:00:00Z'),
    };
    const page = buildSlackDirectoryPersonPage(profile);

    expect(page.slug).toMatch(/^people\/slack-member-[a-f0-9]{16}$/);
    expect(page.title).toBe('Ada');
    expect(page.content).toContain('type: person');
    expect(page.content).toContain('event_date: 2026-07-01');
    expect(page.content).toContain('job_title: "Mathematician"');
    expect(page.content).toContain('Title: Mathematician');
    expect(page.content).toContain('- Slack: ada (UADA)');
  });

  it('turns a mapped Slack profile into an alias of its canonical Roomote card', () => {
    const page = buildSlackDirectoryPersonPage(
      {
        slackUserId: 'U08TMEM25CP',
        slackTeamId: 'TROOMOTE',
        slackTeamName: 'Roomote',
        username: 'dan',
        displayName: 'Dan Riccio',
        realName: 'Daniel Riccio',
        title: 'VP of Engineering',
        isDeleted: false,
        isBot: false,
        isAppUser: false,
        profileUpdatedAt: new Date('2026-08-15T00:00:00Z'),
        firstKnownAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        slug: 'people/roomote-member-abc',
        title: 'Dan Riccio',
        effectiveDate: new Date('2026-08-01T00:00:00Z'),
      },
    );

    expect(page.content).toContain('type: person-alias');
    expect(page.content).toContain('event_date: 2026-07-01');
    expect(page.content).toContain('canonical: "people/roomote-member-abc"');
    expect(page.content).toContain('[Dan Riccio](people/roomote-member-abc)');
  });

  it('paginates full reconciliation sweeps without timestamp gaps', () => {
    const second = { ...record, userId: 'user-zed', name: 'Zed Example' };
    const firstBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 1,
    });
    const secondBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: {
        watermark: firstBatch.watermark,
        cursor: firstBatch.cursor,
      },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 1,
    });

    expect(firstBatch.records.map(({ userId }) => userId)).toEqual([
      'user-dan',
    ]);
    expect(firstBatch.projectionChanged).toBe(true);
    expect(secondBatch.records.map(({ userId }) => userId)).toEqual([
      'user-zed',
    ]);
    expect(secondBatch.projectionChanged).toBe(false);
    expect(JSON.parse(secondBatch.cursor)).toMatchObject({ mode: 'idle' });
  });

  it('detects identity projection changes independently of page pagination', () => {
    const initial = selectPersonIdentityBatch({
      records: [record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });
    const changed = selectPersonIdentityBatch({
      records: [
        {
          ...record,
          providers: [
            ...record.providers,
            {
              provider: 'GitHub',
              identifier: 'dan-renamed',
              updatedAt: new Date('2026-08-15T00:01:00Z'),
            },
          ],
        },
      ],
      state: { watermark: initial.watermark, cursor: initial.cursor },
      now: new Date('2026-08-15T00:02:00Z'),
      limit: 100,
    });

    expect(changed.projectionChanged).toBe(true);
  });

  it('refreshes canonical cards when a provider projection changes with an old timestamp', () => {
    const initial = selectPersonIdentityBatch({
      records: [record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });
    const changedRecord = {
      ...record,
      providers: record.providers.map((provider) =>
        provider.provider === 'Slack'
          ? { ...provider, title: 'Chief Analogy Officer' }
          : provider,
      ),
    };
    const changed = selectPersonIdentityBatch({
      records: [changedRecord],
      state: { watermark: initial.watermark, cursor: initial.cursor },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 100,
    });

    expect(changed.projectionChanged).toBe(true);
    expect(changed.records).toEqual([changedRecord]);
    expect(buildPersonIdentityPage(changed.records[0]!).content).toContain(
      'Chief Analogy Officer',
    );
  });

  it('restarts an active sweep when an earlier provider projection changes', () => {
    const second = { ...record, userId: 'user-zed', name: 'Zed Example' };
    const firstBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 1,
    });
    const changedRecord = {
      ...record,
      providers: record.providers.map((provider) =>
        provider.provider === 'Slack'
          ? { ...provider, title: 'Chief Analogy Officer' }
          : provider,
      ),
    };
    const restarted = selectPersonIdentityBatch({
      records: [second, changedRecord],
      state: { watermark: firstBatch.watermark, cursor: firstBatch.cursor },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 1,
    });

    expect(restarted.projectionChanged).toBe(true);
    expect(restarted.records).toEqual([changedRecord]);
  });

  it('periodically reconciles mapping removals and late timestamp ties', () => {
    const staleCursor = JSON.stringify({
      mode: 'incremental',
      lastSweepAt: '2026-08-13T00:00:00Z',
      afterUpdatedAt: record.updatedAt.toISOString(),
      afterUserId: 'user-zed',
    });
    const recordWithoutProviders = { ...record, providers: [] };
    const batch = selectPersonIdentityBatch({
      records: [recordWithoutProviders],
      state: {
        watermark: record.updatedAt,
        cursor: staleCursor,
      },
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });

    expect(batch.records).toEqual([recordWithoutProviders]);
    expect(buildPersonIdentityPage(batch.records[0]!).content).not.toContain(
      'daniel-lxs',
    );
    expect(JSON.parse(batch.cursor)).toMatchObject({ mode: 'idle' });
  });
});
