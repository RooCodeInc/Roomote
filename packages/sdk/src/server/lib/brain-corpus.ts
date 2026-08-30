/**
 * Read-only look at what the Brain actually holds, for the Settings page.
 *
 * Every other Brain surface either writes (the ingestion outbox and the
 * collectors) or proxies an agent's own call. This one asks the corpus what is
 * in it so an admin can see the thing instead of inferring it from Roomote's
 * ingestion checkpoints, which describe what was sent rather than what landed.
 *
 * The listing is an exhaustive census. gbrain caps each `list_pages` response
 * at 100 rows, so this module keyset-pages the whole corpus and caches the
 * result. Settings reads then aggregate and filter one stable snapshot instead
 * of repeatedly walking the Brain.
 */

import { getRedis } from '@roomote/redis';

import { resolveBrainConnection } from './brain-clients';
import { callBrainTool } from './brain-mcp';

/**
 * A single unreachable listing window must not hold Settings open forever.
 * Successful exhaustive walks can take longer because large corpora require
 * many calls, but each call remains independently bounded.
 */
const CORPUS_REQUEST_TIMEOUT_MS = 8_000;

export type BrainCorpusPage = {
  slug: string;
  title: string | null;
  updatedAt: Date | null;
};

export type BrainCorpusSnapshot = {
  pages: BrainCorpusPage[];
};

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toCorpusPage(entry: unknown): BrainCorpusPage | null {
  if (typeof entry === 'string') {
    return entry.trim()
      ? { slug: entry.trim(), title: null, updatedAt: null }
      : null;
  }

  if (typeof entry !== 'object' || entry === null) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const slug = typeof record.slug === 'string' ? record.slug.trim() : '';

  if (!slug) {
    return null;
  }

  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : null;

  return {
    slug,
    title,
    // gbrain has used more than one name for a page's date across versions,
    // and the chart only needs the newest one that parses.
    updatedAt:
      toDate(record.updated_at) ??
      toDate(record.modified_at) ??
      toDate(record.effective_date) ??
      null,
  };
}

/**
 * Pull the page list out of whatever shape the tool answered with: a bare
 * array, an array wrapped under `pages`/`results`, or a newline-delimited text
 * block. Being generous here is the point — a corpus listing that fails to
 * parse would show an admin an empty Brain, which is the one wrong answer.
 */
export function extractBrainCorpusPages(
  payloads: unknown[],
): BrainCorpusPage[] {
  const pages = new Map<string, BrainCorpusPage>();

  const absorb = (entries: unknown[]) => {
    for (const entry of entries) {
      const page = toCorpusPage(entry);

      if (page && !pages.has(page.slug)) {
        pages.set(page.slug, page);
      }
    }
  };

  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      absorb(payload);
      continue;
    }

    if (typeof payload === 'string') {
      absorb(payload.split('\n').map((line) => line.trim()));
      continue;
    }

    if (typeof payload === 'object' && payload !== null) {
      for (const key of ['pages', 'results', 'items']) {
        const nested = (payload as Record<string, unknown>)[key];

        if (Array.isArray(nested)) {
          absorb(nested);
        }
      }
    }
  }

  return [...pages.values()];
}

/**
 * A full walk can be expensive, so keep it for ten minutes. Once stale, the
 * previous complete snapshot is served immediately while one shared refresh
 * runs. A failed refresh never replaces known-complete data.
 */
const CORPUS_CACHE_TTL_MS = 10 * 60_000;
const CORPUS_FAILURE_CACHE_TTL_MS = 30_000;

let corpusCache: {
  snapshot: BrainCorpusSnapshot | null;
  expiresAtMs: number;
  load: Promise<BrainCorpusSnapshot | null> | null;
  refresh: Promise<BrainCorpusSnapshot | null> | null;
} = { snapshot: null, expiresAtMs: 0, load: null, refresh: null };

/** Drop the cached census, so the next call re-reads the corpus. */
export function resetBrainCorpusCache(): void {
  corpusCache = {
    snapshot: null,
    expiresAtMs: 0,
    load: null,
    refresh: null,
  };
}

/**
 * The most pages one `list_pages` call returns. gbrain caps `limit` at 100.
 */
const CORPUS_LISTING_WINDOW = 100;

type CorpusCursor = {
  after: string | null;
  offset: number;
  lastSlug: string | null;
};

type BrainConnection = NonNullable<
  Awaited<ReturnType<typeof resolveBrainConnection>>
>;

type StoredBrainCorpus = {
  generatedAt: string;
  pages: Array<
    Omit<BrainCorpusPage, 'updatedAt'> & { updatedAt: string | null }
  >;
};

function corpusRedisKey(connection: BrainConnection): string {
  return `brain:settings:corpus:v1:${encodeURIComponent(connection.baseUrl)}`;
}

async function readStoredCorpus(
  connection: BrainConnection,
): Promise<{ snapshot: BrainCorpusSnapshot; generatedAtMs: number } | null> {
  try {
    const raw = await getRedis().get(corpusRedisKey(connection));

    if (!raw) {
      return null;
    }

    const stored = JSON.parse(raw) as StoredBrainCorpus;
    const generatedAtMs = new Date(stored.generatedAt).getTime();

    if (!Array.isArray(stored.pages) || Number.isNaN(generatedAtMs)) {
      return null;
    }

    return {
      generatedAtMs,
      snapshot: {
        pages: stored.pages.map((page) => ({
          ...page,
          updatedAt: toDate(page.updatedAt),
        })),
      },
    };
  } catch (error) {
    console.warn(
      `[brain] stored corpus read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function storeCorpus(
  connection: BrainConnection,
  snapshot: BrainCorpusSnapshot,
): Promise<void> {
  const stored: StoredBrainCorpus = {
    generatedAt: new Date().toISOString(),
    pages: snapshot.pages.map((page) => ({
      ...page,
      updatedAt: page.updatedAt?.toISOString() ?? null,
    })),
  };

  try {
    // No Redis expiry: an old complete census is preferable to a cold full
    // walk after every process restart. generatedAt controls refresh timing.
    await getRedis().set(corpusRedisKey(connection), JSON.stringify(stored));
  } catch (error) {
    console.warn(
      `[brain] stored corpus write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function fetchBrainCorpus(
  connection: BrainConnection,
): Promise<BrainCorpusSnapshot | null> {
  try {
    const pages = new Map<string, BrainCorpusPage>();
    let cursor: CorpusCursor = { after: null, offset: 0, lastSlug: null };

    for (;;) {
      const overlapping = cursor.offset > 0 && cursor.lastSlug !== null;
      const requestOffset = overlapping ? cursor.offset - 1 : cursor.offset;
      const payloads = await callBrainTool(
        connection,
        'list_pages',
        {
          limit: CORPUS_LISTING_WINDOW,
          sort: 'updated_asc',
          ...(cursor.after ? { updated_after: cursor.after } : {}),
          ...(requestOffset > 0 ? { offset: requestOffset } : {}),
        },
        { timeoutMs: CORPUS_REQUEST_TIMEOUT_MS },
      );
      let window = extractBrainCorpusPages(payloads);
      const windowFull = window.length >= CORPUS_LISTING_WINDOW;

      if (overlapping) {
        if (window[0]?.slug !== cursor.lastSlug) {
          throw new Error(
            'list_pages ignored or invalidated the offset cursor',
          );
        }

        window = window.slice(1);
      }

      for (const page of window) {
        if (!pages.has(page.slug)) {
          pages.set(page.slug, page);
        }
      }

      if (!windowFull) {
        break;
      }

      const lastAt = window.at(-1)?.updatedAt ?? null;
      const earlier = lastAt
        ? window.filter((page) => page.updatedAt && page.updatedAt < lastAt)
        : [];
      const someEarlier = Boolean(
        lastAt &&
        window.some(
          (page) =>
            !page.updatedAt || page.updatedAt.getTime() !== lastAt.getTime(),
        ),
      );

      if (!lastAt || (someEarlier && earlier.length === 0)) {
        throw new Error('list_pages is not walkable in updated_at order');
      }

      let next: CorpusCursor;

      if (someEarlier) {
        const boundary = earlier.reduce((latest, page) =>
          page.updatedAt! > latest.updatedAt! ? page : latest,
        );
        next = {
          after: boundary.updatedAt!.toISOString(),
          offset: 0,
          lastSlug: null,
        };
      } else {
        next = {
          after: cursor.after,
          offset: cursor.offset + window.length,
          lastSlug: window.at(-1)!.slug,
        };
      }

      if (next.after === cursor.after && next.offset === cursor.offset) {
        throw new Error('list_pages ignored the pagination cursor');
      }

      cursor = next;
    }

    return {
      pages: [...pages.values()].sort(
        (left, right) =>
          (right.updatedAt?.getTime() ?? 0) -
            (left.updatedAt?.getTime() ?? 0) ||
          left.slug.localeCompare(right.slug),
      ),
    };
  } catch (error) {
    console.warn(
      `[brain] corpus listing failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

/**
 * Read the full corpus with the read-only agent credential, or return null when
 * the Brain is unconfigured or unreachable. Never throws: an unreachable Brain
 * is a state the page renders, not an error that takes the page down with it.
 */
export async function readBrainCorpus(): Promise<BrainCorpusSnapshot | null> {
  if (corpusCache.expiresAtMs > Date.now()) {
    return corpusCache.snapshot;
  }

  const refresh = (connection?: BrainConnection) => {
    if (corpusCache.refresh) {
      return corpusCache.refresh;
    }

    corpusCache.refresh = (async () => {
      const resolved = connection ?? (await resolveBrainConnection('agent'));

      if (!resolved) {
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
        return null;
      }

      const snapshot = await fetchBrainCorpus(resolved);

      if (snapshot && snapshot.pages.length > 0) {
        corpusCache.snapshot = snapshot;
        corpusCache.expiresAtMs = Date.now() + CORPUS_CACHE_TTL_MS;
        await storeCorpus(resolved, snapshot);
      } else if (snapshot) {
        // An empty census is served but never trusted for the full TTL: a
        // brain's first ingestion typically lands minutes after the first
        // (empty) settings-page read, and a ten-minute cached "nothing here"
        // makes fresh Memory look broken. An empty walk is also the cheapest
        // walk (one call), so re-reading soon costs nothing.
        corpusCache.snapshot = snapshot;
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
      } else {
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
      }

      return snapshot;
    })()
      .catch((error) => {
        console.warn(
          `[brain] corpus refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
        return null;
      })
      .finally(() => {
        corpusCache.refresh = null;
      });

    return corpusCache.refresh;
  };

  if (corpusCache.snapshot) {
    // An expired empty snapshot must not ride stale-while-revalidate: the
    // whole point of its short TTL is that first ingestion is probably
    // landing right now, and serving "nothing here" once more while the
    // refresh runs re-creates the empty settings page this path exists to
    // avoid. The awaited walk is cheap — the corpus was empty moments ago.
    if (corpusCache.snapshot.pages.length === 0) {
      return (await refresh()) ?? corpusCache.snapshot;
    }

    void refresh();
    return corpusCache.snapshot;
  }

  if (!corpusCache.load) {
    corpusCache.load = (async () => {
      const connection = await resolveBrainConnection('agent');

      if (!connection) {
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
        return null;
      }

      const stored = await readStoredCorpus(connection);

      // A stored empty census (including ones persisted before empties
      // stopped being stored) is as cheap to redo as to trust — walk fresh.
      if (!stored || stored.snapshot.pages.length === 0) {
        return refresh(connection);
      }

      corpusCache.snapshot = stored.snapshot;
      corpusCache.expiresAtMs = Math.max(
        stored.generatedAtMs + CORPUS_CACHE_TTL_MS,
        Date.now() + CORPUS_FAILURE_CACHE_TTL_MS,
      );

      if (stored.generatedAtMs + CORPUS_CACHE_TTL_MS <= Date.now()) {
        void refresh(connection);
      }

      return stored.snapshot;
    })()
      .catch((error) => {
        console.warn(
          `[brain] corpus cache load failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        corpusCache.expiresAtMs = Date.now() + CORPUS_FAILURE_CACHE_TTL_MS;
        return null;
      })
      .finally(() => {
        corpusCache.load = null;
      });
  }

  return corpusCache.load;
}

export type BrainCorpusPageContent = BrainCorpusPage & {
  /** The page body as the Brain stores it, or null when it answered without one. */
  content: string | null;
};

/**
 * Pull a single page's body out of whatever shape `get_page` answered with.
 * The same generosity as the listing parser, for the same reason: a page that
 * fails to parse would read as an empty page, which is the one wrong answer.
 */
export function extractBrainPageContent(
  slug: string,
  payloads: unknown[],
): BrainCorpusPageContent | null {
  let title: string | null = null;
  let updatedAt: Date | null = null;
  let content: string | null = null;

  for (const payload of payloads) {
    if (typeof payload === 'string') {
      content ??= payload;
      continue;
    }

    if (typeof payload !== 'object' || payload === null) {
      continue;
    }

    const record = payload as Record<string, unknown>;
    const nested =
      typeof record.page === 'object' && record.page !== null
        ? (record.page as Record<string, unknown>)
        : record;

    // `compiled_truth` is the body key gbrain actually answers `get_page`
    // with (the maintenance job's synthesis reads rely on it); the rest are
    // tolerance for older or alternate renderings.
    for (const key of ['compiled_truth', 'content', 'markdown', 'text']) {
      const value = nested[key];

      if (typeof value === 'string' && value.trim()) {
        content ??= value;
        break;
      }
    }

    if (typeof nested.title === 'string' && nested.title.trim()) {
      title ??= nested.title.trim();
    }

    const page = toCorpusPage(nested);

    if (page?.updatedAt) {
      updatedAt ??= page.updatedAt;
    }
  }

  if (content === null && title === null) {
    return null;
  }

  return { slug, title, updatedAt, content };
}

/**
 * Read one page with the read-only agent credential, or return null when the
 * Brain is unconfigured, unreachable, or has no such page. Same non-throwing
 * contract as the corpus sample: absence is a state the dialog renders.
 */
export async function readBrainPage(
  slug: string,
): Promise<BrainCorpusPageContent | null> {
  const connection = await resolveBrainConnection('agent');

  if (!connection) {
    return null;
  }

  try {
    const payloads = await callBrainTool(
      connection,
      'get_page',
      { slug, fuzzy: false },
      { timeoutMs: CORPUS_REQUEST_TIMEOUT_MS },
    );

    return extractBrainPageContent(slug, payloads);
  } catch (error) {
    console.warn(
      `[brain] page read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}
