import { decrypt } from '@roomote/db/encryption';
import {
  findBrainSourceConnectionConfig,
  isBrainSourceAvailable,
} from '@roomote/sdk/server';
import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  renderBrainFrontmatter,
} from '@roomote/types';

import type { BrainCollector, CollectorPage } from './contracts';
import {
  normalizeIdentityAlias,
  type PersonIdentityReference,
} from './identity';
import {
  buildPersonIdentityLookup,
  loadPersonIdentityRecords,
} from './person-identities';
import { asString, formatUtcDay, parseDate, slugifySegment } from './shared';

const LOG_PREFIX = '[brainCollectors]';
const GRANOLA_MEETINGS_COLLECTOR_ID = BRAIN_COLLECTOR_IDS.granolaMeetings;

/**
 * Granola: meeting notes
 * ----------------------
 *
 * Minimal REST client against Granola's public API using the admin-configured
 * deployment credential (same connection the Granola MCP handler resolves).
 * Bounded: first pass takes the most recent ~50 notes; later passes filter
 * with `updated_after` from the watermark.
 */

const GRANOLA_API_BASE_URL = 'https://public-api.granola.ai';
const GRANOLA_PAGE_SIZE = 30; // Granola's documented per-page maximum.
const GRANOLA_MAX_NOTES_PER_TICK = 50;
/** Enough to page to the note ceiling, with headroom for short pages. */
const GRANOLA_MAX_REQUESTS_PER_TICK = 10;
/** Granola allows five sustained requests per second. */
const GRANOLA_REQUEST_INTERVAL_MS = 210;

type GranolaAttendee = { display: string; identityCandidates: string[] };

function extractAttendees(note: Record<string, unknown>): GranolaAttendee[] {
  const raw = note.attendees ?? note.people ?? note.participants;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        const value = entry.trim();
        return value ? { display: value, identityCandidates: [value] } : null;
      }

      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = asString(record.name);
        const email = asString(record.email);
        const identityCandidates = [name, email].filter(
          (value): value is string => Boolean(value),
        );

        return identityCandidates.length > 0
          ? {
              display: name ?? email!,
              identityCandidates,
            }
          : null;
      }

      return null;
    })
    .filter((attendee): attendee is GranolaAttendee => Boolean(attendee));
}

const GRANOLA_NOTE_EXCERPT_MAX_CHARS = 3000;

/**
 * Map one Granola note object to a memory page. Defensive by design: the
 * exact response shape is not contract-pinned, so unknown shapes produce
 * `null` (zero pages) instead of throwing. Pure function, exported for tests.
 */
export function buildGranolaMeetingPage(
  note: unknown,
  identities: ReadonlyMap<string, PersonIdentityReference> = new Map(),
): { page: CollectorPage; updatedAt: Date | null } | null {
  if (!note || typeof note !== 'object') {
    return null;
  }

  const record = note as Record<string, unknown>;
  const id = asString(record.id);
  const title = asString(record.title) ?? 'Untitled meeting';

  if (!id && !asString(record.title)) {
    return null;
  }

  const createdAt = parseDate(record.created_at) ?? parseDate(record.createdAt);
  const updatedAt =
    parseDate(record.updated_at) ?? parseDate(record.updatedAt) ?? createdAt;
  const day = createdAt ? formatUtcDay(createdAt) : 'undated';
  const titleSlug = slugifySegment(title) || 'meeting';
  const idSlug = id ? slugifySegment(id) : null;
  const slugTail = idSlug ? `${titleSlug}-${idSlug}` : titleSlug;
  const attendees = extractAttendees(record);
  const resolvedAttendees = attendees.map((attendee) => ({
    display: attendee.display,
    identity: attendee.identityCandidates
      .map((candidate) => identities.get(normalizeIdentityAlias(candidate)))
      .find(Boolean),
  }));
  const attendeeSlugs = [
    ...new Set(
      resolvedAttendees
        .map(({ identity }) => identity?.slug)
        .filter((slug): slug is string => Boolean(slug)),
    ),
  ];
  const body =
    asString(record.summary_markdown) ??
    asString(record.summary_text) ??
    asString(record.summary) ??
    asString(record.overview) ??
    asString(record.notes_markdown) ??
    asString(record.notes_plain) ??
    asString(record.notes) ??
    asString(record.content) ??
    '';
  const excerpt = body.slice(0, GRANOLA_NOTE_EXCERPT_MAX_CHARS);

  const content = [
    ...renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.meeting,
      title,
      created: day,
      fields: [
        id && `granola_note_id: ${id}`,
        `date: ${day}`,
        'provenance: roomote-granola-meetings',
        attendeeSlugs.length > 0 &&
          `attendees: ${JSON.stringify(attendeeSlugs)}`,
      ],
    }),
    '',
    `# ${title}`,
    '',
    `Meeting on ${day}.`,
    ...(resolvedAttendees.length > 0
      ? [
          '',
          '## Attendees',
          '',
          ...resolvedAttendees.map(({ display, identity }) =>
            identity
              ? `- [${identity.title}](${identity.slug})`
              : `- ${display}`,
          ),
        ]
      : []),
    ...(excerpt ? ['', '## Notes', '', excerpt] : []),
    '',
  ].join('\n');

  return {
    page: {
      slug: `${brainNamespacePrefix('meetings')}${day}-${slugTail}`,
      title,
      content,
      timelineEvidence:
        id && createdAt
          ? attendeeSlugs.map((slug) => ({
              slug,
              date: day,
              summary: 'Attended a meeting recorded in Granola',
              source: `granola:note:${id}`,
            }))
          : [],
    },
    updatedAt,
  };
}

export async function fetchGranolaNoteDetail(
  note: unknown,
  apiKey: string,
): Promise<unknown | null> {
  if (!note || typeof note !== 'object') {
    return null;
  }

  const id = asString((note as Record<string, unknown>).id);

  if (!id) {
    return null;
  }

  const url = new URL(
    `v1/notes/${encodeURIComponent(id)}`,
    `${GRANOLA_API_BASE_URL}/`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // A note can disappear between the list and detail requests. Skipping that
  // one note lets the remaining accessible history continue rebuilding.
  if (response.status === 404) {
    console.warn(
      `${LOG_PREFIX} granola note ${id} disappeared before its details were fetched`,
    );
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Granola get-note failed for ${id} with status ${response.status}`,
    );
  }

  const detail = await response.json().catch(() => null);

  if (!detail || typeof detail !== 'object') {
    throw new Error(`Granola get-note returned an invalid payload for ${id}`);
  }

  return detail;
}

async function hydrateGranolaNotes(
  notes: unknown[],
  apiKey: string,
): Promise<unknown[]> {
  const details: unknown[] = [];

  for (const note of notes) {
    // List calls count against the same workspace limit, so leave a full
    // request interval before every detail request rather than bursting.
    await new Promise((resolve) =>
      setTimeout(resolve, GRANOLA_REQUEST_INTERVAL_MS),
    );
    const detail = await fetchGranolaNoteDetail(note, apiKey);

    if (detail) {
      details.push(detail);
    }
  }

  return details;
}

async function collectGranolaMeetings(input: {
  since: Date | null;
  limit: number;
}): Promise<{ pages: CollectorPage[]; nextSince: Date | null }> {
  const config = await findBrainSourceConnectionConfig('granola');

  if (!config) {
    return { pages: [], nextSince: null };
  }

  const apiKey = decrypt(config.encryptedApiKey).trim();

  if (!apiKey) {
    console.warn(
      `${LOG_PREFIX} granola connection has an empty stored API key; producing no pages`,
    );
    return { pages: [], nextSince: null };
  }

  const notes: unknown[] = [];
  let cursor: string | null = null;
  let requests = 0;

  // Bounded by requests as well as notes: an upstream that keeps answering
  // "more pages" while returning none would otherwise spin here forever.
  while (
    notes.length < GRANOLA_MAX_NOTES_PER_TICK &&
    requests < GRANOLA_MAX_REQUESTS_PER_TICK
  ) {
    requests++;
    const url = new URL('v1/notes', `${GRANOLA_API_BASE_URL}/`);

    url.searchParams.set('page_size', String(GRANOLA_PAGE_SIZE));

    if (input.since) {
      url.searchParams.set('updated_after', input.since.toISOString());
    }

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status === 401 || response.status === 403) {
      console.warn(
        `${LOG_PREFIX} granola rejected the stored API key (${response.status}); producing no pages`,
      );
      return { pages: [], nextSince: null };
    }

    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} granola list-notes failed with status ${response.status}; using ${notes.length} notes fetched so far`,
      );
      break;
    }

    const payload = (await response.json().catch(() => null)) as {
      notes?: unknown[];
      hasMore?: boolean;
      cursor?: string | null;
    } | null;

    if (!payload || !Array.isArray(payload.notes)) {
      console.warn(
        `${LOG_PREFIX} granola list-notes returned an unexpected payload shape; producing no further pages`,
      );
      break;
    }

    notes.push(...payload.notes);
    cursor = payload.hasMore && payload.cursor ? payload.cursor : null;

    if (!cursor) {
      break;
    }
  }

  const detailedNotes = await hydrateGranolaNotes(
    notes.slice(0, GRANOLA_MAX_NOTES_PER_TICK),
    apiKey,
  );
  const pages: CollectorPage[] = [];
  let nextSince: Date | null = null;
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );

  for (const note of detailedNotes) {
    const mapped = buildGranolaMeetingPage(note, identities);

    if (!mapped) {
      continue;
    }

    pages.push(mapped.page);

    if (mapped.updatedAt && (!nextSince || mapped.updatedAt > nextSince)) {
      nextSince = mapped.updatedAt;
    }
  }

  return { pages: pages.slice(0, input.limit), nextSince };
}

/**
 * One backfill step: one API page of the full note history (no
 * `updated_after` filter). The durable backfillCursor is Granola's own
 * pagination cursor; done when the API stops returning one.
 */
async function backfillGranolaNotesStep(cursor: string | null): Promise<{
  pages: CollectorPage[];
  nextCursor: string | null;
  done: boolean;
}> {
  const noProgress = { pages: [], nextCursor: cursor, done: false };
  const config = await findBrainSourceConnectionConfig('granola');

  if (!config) {
    return noProgress;
  }

  const apiKey = decrypt(config.encryptedApiKey).trim();

  if (!apiKey) {
    console.warn(
      `${LOG_PREFIX} granola connection has an empty stored API key; backfill will retry next tick`,
    );
    return noProgress;
  }

  const url = new URL('v1/notes', `${GRANOLA_API_BASE_URL}/`);

  url.searchParams.set('page_size', String(GRANOLA_PAGE_SIZE));

  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    console.warn(
      `${LOG_PREFIX} granola backfill list-notes failed with status ${response.status}; will retry next tick`,
    );
    return noProgress;
  }

  const payload = (await response.json().catch(() => null)) as {
    notes?: unknown[];
    hasMore?: boolean;
    cursor?: string | null;
  } | null;

  if (!payload || !Array.isArray(payload.notes)) {
    console.warn(
      `${LOG_PREFIX} granola backfill list-notes returned an unexpected payload shape; will retry next tick`,
    );
    return noProgress;
  }

  const detailedNotes = await hydrateGranolaNotes(payload.notes, apiKey);
  const pages: CollectorPage[] = [];
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );

  for (const note of detailedNotes) {
    const mapped = buildGranolaMeetingPage(note, identities);

    if (mapped) {
      pages.push(mapped.page);
    }
  }

  const nextCursor = payload.hasMore && payload.cursor ? payload.cursor : null;

  return { pages, nextCursor, done: !nextCursor };
}

export const granolaMeetingsCollector: BrainCollector = {
  id: GRANOLA_MEETINGS_COLLECTOR_ID,
  displayName: 'Granola meeting notes',
  async isEnabled() {
    return isBrainSourceAvailable('granola');
  },
  async collect({ since, limit }) {
    return collectGranolaMeetings({ since, limit });
  },
  async backfill({ cursor }) {
    return backfillGranolaNotesStep(cursor);
  },
};
